// Soul KV-Cache v9.0 - Backup/Restore engine. sqlite-store compatible DB backup.
import path from 'path';
import { memorySegment } from './atomic-json';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { atomicWrite, acquireLock, readStrict } from '../durable';
import { writeFile, writeJson } from '../utils';
// SessionData types imported lazily

/** Raw snapshot structure as written to JSON files */
interface SnapshotRaw {
  id?: string;
  agentName?: string;
  agentType?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  turnCount?: number;
  tokenEstimate?: number;
  keys?: string[];
  context?: Record<string, unknown>;
  parentSessionId?: string;
  projectName?: string;
}
// Lazy-import sql.js types (same as sqlite-store)
interface SqlJsModule {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

interface SqlJsDatabase {
  run(sql: string, params?: (string | number | null | Uint8Array)[]): void;
  exec(sql: string, params?: (string | number | null | Uint8Array)[]): SqlJsResult[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  run(params: (string | number | null | Uint8Array)[]): void;
  free(): void;
}

interface SqlJsResult {
  columns: string[];
  values: (string | number | null | Uint8Array)[][];
}

interface BackupConfig {
  snapshotDir?: string; sqliteDir?: string; backend?: string;
  dir?: string;
  keepCount?: number;
  incremental?: boolean;
}

export interface ManifestEntry {
  id: string;
  type: string;
  timestamp: string;
  sizeBytes: number;
  snapshots?: number;
  embeddings?: number;
}

interface Manifest {
  backups: ManifestEntry[];
  lastBackup: string | null;
}

export interface BackupResult {
  backupId: string | null;
  snapshots?: number;
  embeddings?: number;
  sizeBytes: number;
  sizeFormatted?: string;
  type: string;
  path?: string;
  message?: string;
  error?: string;
}

export interface RestoreResult {
  restored: number | string;
  embeddings?: number;
  backupId?: string;
  target?: string;
  error?: string;
}

interface RestoreOptions {
  target?: 'sqlite' | 'json';
}

export interface BackupStatusResult {
  project: string;
  totalBackups: number;
  lastBackup: string | null;
  totalBackupSize: string;
  keepCount: number;
}

interface BackupOptions {
  full?: boolean;
}

/** KV-Cache Backup Manager */
export class BackupManager {
  private readonly dataDir: string;
  private readonly snapshotDir: string;
  private readonly sqliteDir: string;
  private readonly backend?: string;
  private readonly backupDir: string;
  private readonly keepCount: number;
  private _SQL: SqlJsModule | null;

  constructor(dataDir: string, config: BackupConfig = {}) {
    this.dataDir = dataDir;
    this.snapshotDir = config.snapshotDir || path.join(dataDir, 'kv-cache', 'snapshots');
    this.sqliteDir = config.sqliteDir || path.join(dataDir, 'kv-cache', 'sqlite');
    this.backend = config.backend;
    this.backupDir = config.dir || path.join(dataDir, 'kv-cache', 'backups');
    this.keepCount = config.keepCount || 7;
    this._SQL = null;
  }

  private async _initSql(): Promise<SqlJsModule> {
    if (this._SQL) return this._SQL;
    const { initSqlJs } = await import('./sqlite-store');
    this._SQL = await initSqlJs();
    return this._SQL;
  }

  /** Backup all project data into a sqlite-store compatible DB */
  async backup(project: string, options: BackupOptions = {}): Promise<BackupResult> {
    const release = acquireLock(path.join(this.backupDir, memorySegment(project), 'backup.lock'));
    try { return await this._backupProject(project, options); } finally { release(); }
  }

  private async _backupProject(project: string, options: BackupOptions): Promise<BackupResult> {
    const projectBackupDir = path.join(this.backupDir, memorySegment(project));
    if (!fs.existsSync(projectBackupDir)) fs.mkdirSync(projectBackupDir, { recursive: true });

    const manifest = this._loadManifest(project);
    const sqlitePath = path.join(this.sqliteDir, `${memorySegment(project)}.sqlite`);

    if (this.backend !== 'json' && fs.existsSync(sqlitePath)) {
      return this._backupByCopy(project, sqlitePath, manifest, options);
    }
    return await this._backupFromJson(project, manifest, options);
  }

  private _backupByCopy(
    project: string, sqlitePath: string, manifest: Manifest, options: BackupOptions,
  ): BackupResult {
    if (!options.full && manifest.lastBackup) {
      const lastTime = new Date(manifest.lastBackup).getTime();
      const stat = fs.statSync(sqlitePath);
      if (stat.mtimeMs <= lastTime) {
        return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'skip', message: 'No changes' };
      }
    }

    const backupId = this._makeBackupId();
    const destPath = path.join(this.backupDir, memorySegment(project), `backup-${memorySegment(backupId)}.sqlite`);
    atomicWrite(destPath, fs.readFileSync(sqlitePath));
    const stat = fs.statSync(destPath);

    const entry: ManifestEntry = {
      id: backupId, type: 'copy', timestamp: new Date().toISOString(), sizeBytes: stat.size,
    };
    manifest.backups.push(entry);
    manifest.lastBackup = entry.timestamp;
    this._saveManifest(project, manifest);
    this._cleanup(project);

    return {
      backupId, type: 'copy', sizeBytes: stat.size,
      sizeFormatted: this._formatBytes(stat.size), path: destPath,
    };
  }

  private async _backupFromJson(
    project: string, manifest: Manifest, options: BackupOptions,
  ): Promise<BackupResult> {
    const SQL = await this._initSql();
    const snapDir = path.join(this.snapshotDir, memorySegment(project));
    if (!fs.existsSync(snapDir)) {
      return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'empty', error: 'No snapshots' };
    }

    const snapFiles = this._collectSnapFiles(snapDir);
    if (snapFiles.length === 0) {
      return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'empty', error: 'No snapshots' };
    }

    if (!options.full && manifest.lastBackup) {
      const lastTime = new Date(manifest.lastBackup).getTime();
      const hasChanges = snapFiles.some(f => {
        try { return fs.statSync(f).mtimeMs > lastTime; } catch { return true; }
      });
      if (!hasChanges) {
        return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'skip', message: 'No changes' };
      }
    }

    const db = new SQL.Database();
    this._initBackupSchema(db);
    const snapCount = this._insertSnapshotsIntoDb(db, snapFiles, project);
    const embCount = this._insertEmbeddingsIntoDb(db, project);

    const backupId = this._makeBackupId();
    const destPath = path.join(this.backupDir, memorySegment(project), `backup-${memorySegment(backupId)}.sqlite`);
    const dbData = db.export();
    const buffer = Buffer.from(dbData);
    atomicWrite(destPath, buffer);
    db.close();

    const entry: ManifestEntry = {
      id: backupId, type: 'full', timestamp: new Date().toISOString(),
      snapshots: snapCount, embeddings: embCount, sizeBytes: buffer.length,
    };
    manifest.backups.push(entry);
    manifest.lastBackup = entry.timestamp;
    this._saveManifest(project, manifest);
    this._cleanup(project);

    return {
      backupId, snapshots: snapCount, embeddings: embCount,
      sizeBytes: buffer.length, sizeFormatted: this._formatBytes(buffer.length),
      type: 'full', path: destPath,
    };
  }

  /** Recursively collect JSON snapshot files */
  private _collectSnapFiles(dir: string): string[] {
    const files: string[] = [];
    const scan = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) scan(path.join(d, entry.name));
        else if (entry.name.endsWith('.json')) files.push(path.join(d, entry.name));
      }
    };
    scan(dir);
    return files;
  }

  /** Initialize backup DB schema */
  private _initBackupSchema(db: SqlJsDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, agent_type TEXT DEFAULT 'external',
        model TEXT, started_at TEXT, ended_at TEXT, turn_count INTEGER DEFAULT 0,
        token_estimate INTEGER DEFAULT 0, keys TEXT DEFAULT '[]', context TEXT DEFAULT '{}',
        parent_session_id TEXT, project_name TEXT NOT NULL, raw_json TEXT, metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_name, ended_at DESC)`);
    db.run(`CREATE TABLE IF NOT EXISTS embeddings (snapshot_id TEXT PRIMARY KEY, vector BLOB NOT NULL)`);
  }

  /** Insert snapshots from JSON files into backup DB */
  private _insertSnapshotsIntoDb(db: SqlJsDatabase, snapFiles: string[], project: string): number {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO snapshots
      (id, agent_name, agent_type, model, started_at, ended_at,
       turn_count, token_estimate, keys, context, parent_session_id, project_name, raw_json, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let count = 0;
    try {
      for (const filePath of snapFiles) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const s = JSON.parse(raw) as SnapshotRaw;
          stmt.run([
            s.id ?? '', s.agentName ?? 'unknown', s.agentType ?? 'external',
            s.model ?? null, s.startedAt ?? null,
            s.endedAt ?? null, s.turnCount ?? 0, s.tokenEstimate ?? 0,
            JSON.stringify(s.keys ?? []), JSON.stringify(s.context ?? {}),
            s.parentSessionId ?? null, s.projectName ?? project, raw, raw,
          ]);
          count++;
        } catch { /* skip corrupt */ }
      }
    } finally { stmt.free(); }
    return count;
  }

  /** Insert embeddings into backup DB */
  private _insertEmbeddingsIntoDb(db: SqlJsDatabase, project: string): number {
    const embDir = path.join(this.dataDir, 'kv-cache', 'embeddings', memorySegment(project));
    if (!fs.existsSync(embDir)) return 0;
    let count = 0;
    const stmt = db.prepare('INSERT OR REPLACE INTO embeddings (snapshot_id, vector) VALUES (?, ?)');
    try {
      for (const file of fs.readdirSync(embDir).filter(f => f.endsWith('.json'))) {
        try {
          const vec = fs.readFileSync(path.join(embDir, file), 'utf-8');
          stmt.run([path.basename(file, '.json'), vec]);
          count++;
        } catch { /* skip */ }
      }
    } finally { stmt.free(); }
    return count;
  }

  /** Restore from backup */
  async restore(project: string, backupId?: string | null, options: RestoreOptions = {}): Promise<RestoreResult> {
    const manifest = this._loadManifest(project);
    if (!backupId) {
      if (manifest.backups.length === 0) return { error: 'No backups found', restored: 0 };
      backupId = manifest.backups[manifest.backups.length - 1]?.id ?? '';
    }

    const dbPath = path.join(this.backupDir, memorySegment(project), `backup-${memorySegment(backupId)}.sqlite`);
    if (!fs.existsSync(dbPath)) return { error: `Backup not found: ${backupId}`, restored: 0 };

    if ((options.target || 'json') === 'sqlite') {
      const destDir = this.sqliteDir;
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const release = acquireLock(path.join(destDir, memorySegment(project) + '.lock'));
      try { atomicWrite(path.join(destDir, `${memorySegment(project)}.sqlite`), fs.readFileSync(dbPath)); } finally { release(); }
      return { restored: 'full', backupId, target: 'sqlite' };
    }

    const SQL = await this._initSql();
    const dbData = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbData);

    const restoredSnaps = this._restoreSnapshots(db, project);
    const restoredEmbs = this._restoreEmbeddings(db, project);
    db.close();

    return { restored: restoredSnaps, embeddings: restoredEmbs, backupId, target: 'json' };
  }

  /** Restore snapshots from backup DB to JSON files */
  private _restoreSnapshots(db: SqlJsDatabase, project: string): number {
    const snapDir = path.join(this.snapshotDir, memorySegment(project));
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });

    let count = 0;
    const snapRows = db.exec('SELECT * FROM snapshots');
    if (snapRows.length > 0 && snapRows[0]) {
      const cols = snapRows[0].columns;
      for (const row of snapRows[0].values) {
        const obj: Record<string, string | number | null | Uint8Array> = {};
        cols.forEach((c, i) => { obj[c] = row[i] ?? null; });
        const session = obj.raw_json ? JSON.parse(String(obj.raw_json)) as Record<string, unknown> : {
          ...JSON.parse(String(obj.metadata || '{}')) as Record<string, unknown>,
          id: obj.id, agentName: obj.agent_name, agentType: obj.agent_type,
          model: obj.model, startedAt: obj.started_at, endedAt: obj.ended_at,
          turnCount: obj.turn_count, tokenEstimate: obj.token_estimate,
          keys: JSON.parse(String(obj.keys ?? '[]')) as string[],
          context: JSON.parse(String(obj.context ?? '{}')) as Record<string, unknown>,
          parentSessionId: obj.parent_session_id, projectName: obj.project_name,
        };
        const dateStr = (typeof session.endedAt === 'string' ? session.endedAt : typeof session.startedAt === 'string' ? session.startedAt : '').split('T')[0] || '1970-01-01';
        const dateDir = path.join(snapDir, memorySegment(dateStr));
        if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });
        writeFile(path.join(dateDir, `${memorySegment(String(session.id))}.json`), JSON.stringify(session, null, 2));
        count++;
      }
    }
    return count;
  }

  /** Restore embeddings from backup DB to JSON files */
  private _restoreEmbeddings(db: SqlJsDatabase, project: string): number {
    const embDir = path.join(this.dataDir, 'kv-cache', 'embeddings', memorySegment(project));
    if (!fs.existsSync(embDir)) fs.mkdirSync(embDir, { recursive: true });
    let count = 0;
    const embRows = db.exec('SELECT snapshot_id, vector FROM embeddings');
    if (embRows.length > 0 && embRows[0]) {
      for (const row of embRows[0].values) {
        writeFile(path.join(embDir, `${memorySegment(String(row[0]))}.json`), String(row[1]));
        count++;
      }
    }
    return count;
  }

  /** List backup history */
  list(project: string): (ManifestEntry & { sizeFormatted: string })[] {
    return this._loadManifest(project).backups.map(b => ({
      ...b, sizeFormatted: this._formatBytes(b.sizeBytes),
    }));
  }

  /** Backup status summary */
  status(project: string): BackupStatusResult {
    const manifest = this._loadManifest(project);
    const totalSize = manifest.backups.reduce((s, b) => s + (b.sizeBytes || 0), 0);
    return {
      project, totalBackups: manifest.backups.length,
      lastBackup: manifest.lastBackup, totalBackupSize: this._formatBytes(totalSize),
      keepCount: this.keepCount,
    };
  }

  // -- Helpers --

  private _cleanup(project: string): { deleted: number } {
    const manifest = this._loadManifest(project);
    const dir = path.join(this.backupDir, memorySegment(project));
    let deleted = 0;
    while (manifest.backups.length > this.keepCount) {
      const old = manifest.backups.shift();
      if (old) {
        try { fs.unlinkSync(path.join(dir, `backup-${memorySegment(old.id)}.sqlite`)); deleted++; } catch { /* */ }
      }
    }
    if (deleted > 0) this._saveManifest(project, manifest);
    return { deleted };
  }

  private _makeBackupId(): string {
    const iso = new Date().toISOString();
    return iso.slice(0, 10) + '_' + randomUUID();
  }

  private _loadManifest(project: string): Manifest {
    const p = path.join(this.backupDir, memorySegment(project), 'manifest.json');
    return readStrict<Manifest>(p) ?? { backups: [], lastBackup: null };
  }

  private _saveManifest(project: string, manifest: Manifest): void {
    const dir = path.join(this.backupDir, memorySegment(project));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'manifest.json'), manifest);
  }

  private _formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  }
}
