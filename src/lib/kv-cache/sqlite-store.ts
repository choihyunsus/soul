// Soul KV-Cache v9.0 - SQLite storage engine (pure JS via sql.js). No native deps.
import fs from 'fs';
import { memorySegment } from './atomic-json';
import { acquireLock, atomicWrite } from '../durable';
import path from 'path';
import { createSession } from './schema';
import type { SessionData, SessionInput, SessionContext } from './schema';
import type { StorageAdapter, GCResult } from './storage-adapter';

// sql.js types (WASM-based database)
interface SqlJsModule {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

interface SqlJsDatabase {
  run(sql: string, params?: SqlJsValue[]): void;
  exec(sql: string, params?: SqlJsValue[]): SqlJsResult[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  run(params: SqlJsValue[]): void;
  free(): void;
}

interface SqlJsResult {
  columns: string[];
  values: SqlJsValue[][];
}

type SqlJsValue = string | number | null | Uint8Array;

interface DbEntry {
  db: SqlJsDatabase;
  dirty: boolean;
  path: string;
}

// GCResult imported from storage-adapter.ts

interface ScoredSession extends SessionData {
  _score: number;
}

// Module-level singleton
let _SQL: SqlJsModule | null = null;
let _sqlInitPromise: Promise<SqlJsModule> | null = null;

/** Initialize sql.js module once */
export async function initSqlJs(): Promise<SqlJsModule> {
  if (_SQL) return _SQL;
  if (_sqlInitPromise) return _sqlInitPromise;

  _sqlInitPromise = (async () => {
    const sqlJs = await import('sql.js');
    const initFn = sqlJs.default as unknown as () => Promise<SqlJsModule>;
    _SQL = await initFn();
    return _SQL;
  })();

  return _sqlInitPromise;
}

/** SQLite-backed snapshot storage using sql.js (pure JavaScript WASM) */
export class SqliteStore implements StorageAdapter {
  private readonly baseDir: string;
  private _dbs: Record<string, DbEntry>;
  private _ready: boolean;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this._dbs = Object.create(null) as Record<string, DbEntry>;
    this._ready = false;
  }

  /** Async initialization. Must be called before any operations. */
  async init(): Promise<void> {
    if (this._ready) return;
    await initSqlJs();
    this._ready = true;
  }

  private _assertReady(): void {
    if (!_SQL) {
      throw new Error('SqliteStore not initialized. Call init() first.');
    }
  }

  private _getDb(projectName: string): SqlJsDatabase {
    memorySegment(projectName);
    const existing = this._dbs[projectName];
    if (existing) { existing.db.close(); delete this._dbs[projectName]; }

    this._assertReady();
    const dbPath = path.join(this.baseDir, `${projectName}.sqlite`);
    if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });

    if (!_SQL) throw new Error('SQL.js not initialized');
    let db: SqlJsDatabase;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new _SQL.Database(buffer);
    } else {
      db = new _SQL.Database();
    }

    this._initSnapshotSchema(db);

    this._dbs[projectName] = { db, dirty: false, path: dbPath };
    return db;
  }

  /** Initialize snapshot schema */
  private _initSnapshotSchema(db: SqlJsDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, agent_type TEXT DEFAULT 'external',
        model TEXT, started_at TEXT, ended_at TEXT, turn_count INTEGER DEFAULT 0,
        token_estimate INTEGER DEFAULT 0, keys TEXT DEFAULT '[]', context TEXT DEFAULT '{}',
        parent_session_id TEXT, project_name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    const columns = db.exec('PRAGMA table_info(snapshots)')[0]?.values ?? [];
    if (!columns.some(row => row[1] === 'metadata')) db.run("ALTER TABLE snapshots ADD COLUMN metadata TEXT DEFAULT '{}'");
    db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_name, ended_at DESC)`);
  }

  private _persist(projectName: string): void {
    const entry = this._dbs[projectName];
    if (!entry) return;
    const data = entry.db.export();
    atomicWrite(entry.path, Buffer.from(data));
    entry.dirty = false;
  }

  /** Save a session snapshot */
  async save(session: SessionInput): Promise<string> {
    const s = createSession(session);
    s.endedAt = s.endedAt || new Date().toISOString();

    const release = acquireLock(path.join(this.baseDir, memorySegment(s.projectName) + '.lock'));
    try {
    const db = this._getDb(s.projectName);
    db.run(`
      INSERT OR REPLACE INTO snapshots
      (id, agent_name, agent_type, model, started_at, ended_at,
       turn_count, token_estimate, keys, context, parent_session_id, project_name, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      s.id, s.agentName, s.agentType, s.model,
      s.startedAt, s.endedAt,
      s.turnCount, s.tokenEstimate,
      JSON.stringify(s.keys), JSON.stringify(s.context),
      s.parentSessionId, s.projectName, JSON.stringify({ source: s.source, importance: s.importance, accessCount: s.accessCount, lastAccessed: s.lastAccessed, tier: s.tier }),
    ]);

    this._persist(s.projectName);
    return s.id;
    } finally { release(); }
  }

  /** Load the most recent snapshot */
  async loadLatest(projectName: string): Promise<SessionData | null> {
    const results = await this.list(projectName, 1);
    return results.length > 0 ? (results[0] ?? null) : null;
  }

  /** Load a specific snapshot by ID */
  async loadById(projectName: string, snapshotId: string): Promise<SessionData | null> {
    const db = this._getDb(projectName);
    const results = db.exec('SELECT * FROM snapshots WHERE id = ?', [snapshotId]);
    if (results.length === 0 || !results[0] || results[0].values.length === 0) return null;
    return this._resultToSession(results[0].columns, results[0].values[0] ?? []);
  }

  /** List snapshots sorted by recency */
  async list(projectName: string, limit: number = 10): Promise<SessionData[]> {
    const db = this._getDb(projectName);
    const results = db.exec(`
      SELECT * FROM snapshots
      WHERE project_name = ?
      ORDER BY COALESCE(ended_at, started_at) DESC
      LIMIT ?
    `, [projectName, limit]);

    if (results.length === 0 || !results[0]) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => this._resultToSession(cols, row));
  }

  /** Search snapshots by keyword (LIKE-based) */
  async search(query: string, projectName: string, limit: number = 10): Promise<ScoredSession[]> {
    const db = this._getDb(projectName);
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => `(LOWER(keys) LIKE ? ESCAPE '\\' OR LOWER(context) LIKE ? ESCAPE '\\')`).join(' AND ');
    const params: SqlJsValue[] = [];
    for (const kw of keywords) {
      // Escape LIKE wildcards to prevent unintended matching
      const escaped = kw.replace(/[%_\\]/g, '\\$&');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    params.push(projectName, limit);

    const results = db.exec(`
      SELECT * FROM snapshots
      WHERE ${conditions}
      AND project_name = ?
      ORDER BY COALESCE(ended_at, started_at) DESC
      LIMIT ?
    `, params);

    if (results.length === 0 || !results[0]) return [];
    const cols = results[0].columns;
    return results[0].values
      .map(row => {
        const session = this._resultToSession(cols, row);
        const text = JSON.stringify(session).toLowerCase();
        const _score = keywords.reduce((sum, kw) => {
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return sum + (text.match(new RegExp(escaped, 'g')) || []).length;
        }, 0);
        return { ...session, _score } as ScoredSession;
      })
      .sort((a, b) => b._score - a._score);
  }

  /** Forgetting Curve GC - retention score determines survival */
  async gc(projectName: string, maxAgeDays: number = 30, maxCount: number = 50): Promise<GCResult> {
    const release = acquireLock(path.join(this.baseDir, memorySegment(projectName) + '.lock'));
    try {
    const db = this._getDb(projectName);

    // Load all snapshots for this project
    const results = db.exec(
      'SELECT * FROM snapshots WHERE project_name = ? ORDER BY COALESCE(ended_at, started_at) DESC',
      [projectName],
    );
    if (results.length === 0 || !results[0]) return { deleted: 0 };

    const cols = results[0].columns;
    const snapshots = results[0].values.map(row => this._resultToSession(cols, row));
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    let deleted = 0;
    const survivors: Array<{ snap: SessionData; score: number }> = [];
    const DECAY_RATE = 0.05;

    const owners = new Set<string>();
    const protectedIds = new Set(snapshots.filter(s => {
      const latest = !owners.has(s.agentName); owners.add(s.agentName);
      return latest || s.importance >= 0.8;
    }).map(s => s.id));
    for (const snap of snapshots) {
      const ts = new Date(snap.endedAt || snap.startedAt).getTime();
      if (ts < cutoff && !protectedIds.has(snap.id)) {
        db.run('DELETE FROM snapshots WHERE id = ?', [snap.id]);
        deleted++;
        continue;
      }
      survivors.push({ snap, score: this._calcRetentionScore(snap, DECAY_RATE) });
    }

    // Enforce maxCount: remove lowest-scored snapshots
    if (survivors.length > maxCount) {
      survivors.sort((a, b) => a.score - b.score);
      const excess = survivors.filter(s => !protectedIds.has(s.snap.id)).slice(0, survivors.length - maxCount);
      for (const { snap } of excess) {
        db.run('DELETE FROM snapshots WHERE id = ?', [snap.id]);
        deleted++;
      }
    }

    if (deleted > 0) this._persist(projectName);
    return { deleted };
    } finally { release(); }
  }

  /** Calculate Forgetting Curve retention score */
  private _calcRetentionScore(snap: SessionData, decayRate: number): number {
    const importance = snap.importance ?? 0.5;
    const accessCount = snap.accessCount || 0;
    const lastAccessed = snap.lastAccessed || snap.endedAt || snap.startedAt;
    const ageMs = Date.now() - new Date(lastAccessed).getTime();
    const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
    return Math.min(1.0, importance * (1 + Math.log2(1 + accessCount)) * Math.exp(-decayRate * ageDays));
  }

  private _resultToSession(columns: string[], values: SqlJsValue[]): SessionData {
    const row: Record<string, SqlJsValue> = {};
    columns.forEach((col, i) => { row[col] = values[i] ?? null; });

    const metadata = JSON.parse(String(row.metadata || '{}')) as Partial<SessionData>;
    return {
      ...(metadata.source ? { source: metadata.source } : {}),
      schemaVersion: 2,
      id: String(row.id || ''),
      agentName: String(row.agent_name || 'unknown'),
      agentType: (String(row.agent_type || 'external')) as SessionData['agentType'],
      model: row.model ? String(row.model) : null,
      startedAt: String(row.started_at || ''),
      endedAt: row.ended_at ? String(row.ended_at) : null,
      turnCount: Number(row.turn_count || 0),
      tokenEstimate: Number(row.token_estimate || 0),
      keys: JSON.parse(String(row.keys || '[]')) as string[],
      context: JSON.parse(String(row.context || '{}')) as SessionContext,
      parentSessionId: row.parent_session_id ? String(row.parent_session_id) : null,
      projectName: String(row.project_name || ''),
      accessCount: metadata.accessCount ?? 0,
      lastAccessed: metadata.lastAccessed || String(row.ended_at || row.started_at || ''),
      importance: metadata.importance ?? 0.5,
      tier: metadata.tier || 'warm',
    };
  }

  /** Touch a snapshot - increment access count, update lastAccessed */
  async touch(projectName: string, snapshotId: string): Promise<boolean> {
    const release = acquireLock(path.join(this.baseDir, memorySegment(projectName) + '.lock'));
    try {
    const snap = await this.loadById(projectName, snapshotId);
    if (!snap) return false;

    const db = this._getDb(projectName);
    const now = new Date().toISOString();
    const newCount = (snap.accessCount || 0) + 1;
    db.run(
      'UPDATE snapshots SET metadata = ? WHERE id = ?',
      [JSON.stringify({ source: snap.source, importance: snap.importance, tier: snap.tier, accessCount: newCount, lastAccessed: now }), snapshotId],
    );
    this._persist(projectName);
    return true;
    } finally { release(); }
  }

  /** Close all connections and persist */
  dispose(): void {
    for (const entry of Object.values(this._dbs)) {
      try { entry.db.close(); } catch { /* ignore */ }
    }
    this._dbs = Object.create(null) as Record<string, DbEntry>;
  }

  /** Migrate JSON snapshots to SQLite */
  async migrateFromJson(jsonBaseDir: string, projectName: string): Promise<{ migrated: number; errors: number }> {
    const projectDir = path.join(jsonBaseDir, memorySegment(projectName));
    if (!fs.existsSync(projectDir)) return { migrated: 0, errors: 0 };

    let migrated = 0;
    let errors = 0;

    const dateDirs = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(projectDir, d.name));

    for (const dateDir of dateDirs) {
      const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dateDir, file), 'utf-8');
          await this.save(JSON.parse(raw) as SessionInput);
          migrated++;
        } catch { errors++; }
      }
    }

    return { migrated, errors };
  }
}
