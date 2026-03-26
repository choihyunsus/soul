// Soul KV-Cache v9.0 — Backup/Restore engine. sqlite-store compatible DB backup.
import path from 'path';
import fs from 'fs';
// SessionData types imported lazily

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
  dir?: string;
  keepCount?: number;
  incremental?: boolean;
}

interface ManifestEntry {
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

interface BackupResult {
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

interface RestoreResult {
  restored: number | string;
  embeddings?: number;
  backupId?: string;
  target?: string;
  error?: string;
}

interface RestoreOptions {
  target?: 'sqlite' | 'json';
}

interface BackupOptions {
  full?: boolean;
}

/** KV-Cache Backup Manager */
export class BackupManager {
  private readonly dataDir: string;
  private readonly backupDir: string;
  private readonly keepCount: number;
  private _SQL: SqlJsModule | null;

  constructor(dataDir: string, config: BackupConfig = {}) {
    this.dataDir = dataDir;
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
    const projectBackupDir = path.join(this.backupDir, project);
    if (!fs.existsSync(projectBackupDir)) fs.mkdirSync(projectBackupDir, { recursive: true });

    const manifest = this._loadManifest(project);
    const sqlitePath = path.join(this.dataDir, 'kv-cache', 'sqlite', `${project}.sqlite`);

    if (fs.existsSync(sqlitePath)) {
      return this._backupByCopy(project, sqlitePath, manifest, options);
    }
    return this._backupFromJson(project, manifest, options);
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
    const destPath = path.join(this.backupDir, project, `backup-${backupId}.sqlite`);
    fs.copyFileSync(sqlitePath, destPath);
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
    const snapDir = path.join(this.dataDir, 'kv-cache', 'snapshots', project);

    if (!fs.existsSync(snapDir)) {
      return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'empty', error: 'No snapshots' };
    }

    const snapFiles: string[] = [];
    const scanDir = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) scanDir(path.join(dir, entry.name));
        else if (entry.name.endsWith('.json')) snapFiles.push(path.join(dir, entry.name));
      }
    };
    scanDir(snapDir);

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
    db.run(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, agent_type TEXT DEFAULT 'external',
        model TEXT, started_at TEXT, ended_at TEXT, turn_count INTEGER DEFAULT 0,
        token_estimate INTEGER DEFAULT 0, keys TEXT DEFAULT '[]', context TEXT DEFAULT '{}',
        parent_session_id TEXT, project_name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_name, ended_at DESC)`);
    db.run(`CREATE TABLE IF NOT EXISTS embeddings (snapshot_id TEXT PRIMARY KEY, vector BLOB NOT NULL)`);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO snapshots
      (id, agent_name, agent_type, model, started_at, ended_at,
       turn_count, token_estimate, keys, context, parent_session_id, project_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let snapCount = 0;
    try {
      for (const filePath of snapFiles) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const s = JSON.parse(raw) as Record<string, unknown>;
          stmt.run([
            String(s.id || ''), String(s.agentName || 'unknown'), String(s.agentType || 'external'),
            s.model ? String(s.model) : null, s.startedAt ? String(s.startedAt) : null,
            s.endedAt ? String(s.endedAt) : null, Number(s.turnCount || 0), Number(s.tokenEstimate || 0),
            JSON.stringify(s.keys || []), JSON.stringify(s.context || {}),
            s.parentSessionId ? String(s.parentSessionId) : null, String(s.projectName || project),
          ]);
          snapCount++;
        } catch { /* skip corrupt */ }
      }
    } finally {
      stmt.free();
    }

    // Embeddings backup
    const embDir = path.join(this.dataDir, 'kv-cache', 'embeddings', project);
    let embCount = 0;
    if (fs.existsSync(embDir)) {
      const embStmt = db.prepare('INSERT OR REPLACE INTO embeddings (snapshot_id, vector) VALUES (?, ?)');
      try {
        for (const file of fs.readdirSync(embDir).filter(f => f.endsWith('.json'))) {
          try {
            const vec = fs.readFileSync(path.join(embDir, file), 'utf-8');
            embStmt.run([path.basename(file, '.json'), vec]);
            embCount++;
          } catch { /* skip */ }
        }
      } finally {
        embStmt.free();
      }
    }

    const backupId = this._makeBackupId();
    const destPath = path.join(this.backupDir, project, `backup-${backupId}.sqlite`);
    const dbData = db.export();
    const buffer = Buffer.from(dbData);
    fs.writeFileSync(destPath, buffer);
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

  /** Restore from backup */
  async restore(project: string, backupId?: string | null, options: RestoreOptions = {}): Promise<RestoreResult> {
    const manifest = this._loadManifest(project);
    if (!backupId) {
      if (manifest.backups.length === 0) return { error: 'No backups found', restored: 0 };
      backupId = manifest.backups[manifest.backups.length - 1]?.id ?? '';
    }

    const dbPath = path.join(this.backupDir, project, `backup-${backupId}.sqlite`);
    if (!fs.existsSync(dbPath)) return { error: `Backup not found: ${backupId}`, restored: 0 };

    const target = options.target || 'json';

    if (target === 'sqlite') {
      const destDir = path.join(this.dataDir, 'kv-cache', 'sqlite');
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(dbPath, path.join(destDir, `${project}.sqlite`));
      return { restored: 'full', backupId, target: 'sqlite' };
    }

    const SQL = await this._initSql();
    const dbData = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbData);

    const snapDir = path.join(this.dataDir, 'kv-cache', 'snapshots', project);
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });

    let restoredSnaps = 0;
    const snapRows = db.exec('SELECT * FROM snapshots');
    if (snapRows.length > 0 && snapRows[0]) {
      const cols = snapRows[0].columns;
      for (const row of snapRows[0].values) {
        const obj: Record<string, string | number | null | Uint8Array> = {};
        cols.forEach((c, i) => { obj[c] = row[i] ?? null; });
        const session = {
          id: obj.id, agentName: obj.agent_name, agentType: obj.agent_type,
          model: obj.model, startedAt: obj.started_at, endedAt: obj.ended_at,
          turnCount: obj.turn_count, tokenEstimate: obj.token_estimate,
          keys: JSON.parse(String(obj.keys || '[]')),
          context: JSON.parse(String(obj.context || '{}')),
          parentSessionId: obj.parent_session_id, projectName: obj.project_name,
        };
        fs.writeFileSync(path.join(snapDir, `${String(session.id)}.json`), JSON.stringify(session, null, 2));
        restoredSnaps++;
      }
    }

    const embDir = path.join(this.dataDir, 'kv-cache', 'embeddings', project);
    if (!fs.existsSync(embDir)) fs.mkdirSync(embDir, { recursive: true });
    let restoredEmbs = 0;
    const embRows = db.exec('SELECT snapshot_id, vector FROM embeddings');
    if (embRows.length > 0 && embRows[0]) {
      for (const row of embRows[0].values) {
        fs.writeFileSync(path.join(embDir, `${String(row[0])}.json`), String(row[1]));
        restoredEmbs++;
      }
    }

    db.close();
    return { restored: restoredSnaps, embeddings: restoredEmbs, backupId, target: 'json' };
  }

  /** List backup history */
  list(project: string): (ManifestEntry & { sizeFormatted: string })[] {
    return this._loadManifest(project).backups.map(b => ({
      ...b, sizeFormatted: this._formatBytes(b.sizeBytes),
    }));
  }

  /** Backup status summary */
  status(project: string): Record<string, unknown> {
    const manifest = this._loadManifest(project);
    const totalSize = manifest.backups.reduce((s, b) => s + (b.sizeBytes || 0), 0);
    return {
      project, totalBackups: manifest.backups.length,
      lastBackup: manifest.lastBackup, totalBackupSize: this._formatBytes(totalSize),
      keepCount: this.keepCount,
    };
  }

  // ── Helpers ──

  private _cleanup(project: string): { deleted: number } {
    const manifest = this._loadManifest(project);
    const dir = path.join(this.backupDir, project);
    let deleted = 0;
    while (manifest.backups.length > this.keepCount) {
      const old = manifest.backups.shift();
      if (old) {
        try { fs.unlinkSync(path.join(dir, `backup-${old.id}.sqlite`)); deleted++; } catch { /* */ }
      }
    }
    if (deleted > 0) this._saveManifest(project, manifest);
    return { deleted };
  }

  private _makeBackupId(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private _loadManifest(project: string): Manifest {
    const p = path.join(this.backupDir, project, 'manifest.json');
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as Manifest;
    } catch { /* */ }
    return { backups: [], lastBackup: null };
  }

  private _saveManifest(project: string, manifest: Manifest): void {
    const dir = path.join(this.backupDir, project);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  private _formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  }
}
