// Soul KV-Cache v9.0 — SQLite storage engine (pure JS via sql.js). No native deps.
import fs from 'fs';
import path from 'path';
import { createSession } from './schema';
import type { SessionData, SessionInput, SessionContext } from './schema';

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

interface GCResult {
  deleted: number;
  tiered?: { hot: number; warm: number; cold: number };
}

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
export class SqliteStore {
  private readonly baseDir: string;
  private _dbs: Record<string, DbEntry>;
  private _ready: boolean;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this._dbs = {};
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
    const existing = this._dbs[projectName];
    if (existing) return existing.db;

    this._assertReady();
    const dbPath = path.join(this.baseDir, `${projectName}.sqlite`);
    if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });

    let db: SqlJsDatabase;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new _SQL!.Database(buffer);
    } else {
      db = new _SQL!.Database();
    }

    const isToolCatalog = projectName === '_tool-catalog';

    if (!isToolCatalog) {
      db.run(`
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          agent_type TEXT DEFAULT 'external',
          model TEXT,
          started_at TEXT,
          ended_at TEXT,
          turn_count INTEGER DEFAULT 0,
          token_estimate INTEGER DEFAULT 0,
          keys TEXT DEFAULT '[]',
          context TEXT DEFAULT '{}',
          parent_session_id TEXT,
          project_name TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_name, ended_at DESC)`);
    }

    if (isToolCatalog) {
      db.run(`
        CREATE TABLE IF NOT EXISTS tools (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          source TEXT DEFAULT 'unknown',
          category TEXT DEFAULT 'misc',
          plugin_name TEXT DEFAULT '',
          input_schema TEXT DEFAULT '{}',
          triggers TEXT DEFAULT '[]',
          tags TEXT DEFAULT '[]',
          search_text TEXT DEFAULT '',
          embedding TEXT DEFAULT '',
          usage_count INTEGER DEFAULT 0,
          success_rate REAL DEFAULT 1.0,
          registered_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_tools_source ON tools(source)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_tools_category ON tools(category)`);
    }

    this._dbs[projectName] = { db, dirty: false, path: dbPath };
    return db;
  }

  private _persist(projectName: string): void {
    const entry = this._dbs[projectName];
    if (!entry) return;
    const data = entry.db.export();
    fs.writeFileSync(entry.path, Buffer.from(data));
    entry.dirty = false;
  }

  /** Save a session snapshot */
  save(session: SessionInput): string {
    const s = createSession(session);
    s.endedAt = s.endedAt || new Date().toISOString();

    const db = this._getDb(s.projectName);
    db.run(`
      INSERT OR REPLACE INTO snapshots
      (id, agent_name, agent_type, model, started_at, ended_at,
       turn_count, token_estimate, keys, context, parent_session_id, project_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      s.id, s.agentName, s.agentType, s.model,
      s.startedAt, s.endedAt,
      s.turnCount, s.tokenEstimate,
      JSON.stringify(s.keys), JSON.stringify(s.context),
      s.parentSessionId, s.projectName,
    ]);

    this._persist(s.projectName);
    return s.id;
  }

  /** Load the most recent snapshot */
  loadLatest(projectName: string): SessionData | null {
    const results = this.list(projectName, 1);
    return results.length > 0 ? (results[0] ?? null) : null;
  }

  /** Load a specific snapshot by ID */
  loadById(projectName: string, snapshotId: string): SessionData | null {
    const db = this._getDb(projectName);
    const results = db.exec('SELECT * FROM snapshots WHERE id = ?', [snapshotId]);
    if (results.length === 0 || !results[0] || results[0].values.length === 0) return null;
    return this._resultToSession(results[0].columns, results[0].values[0] ?? []);
  }

  /** List snapshots sorted by recency */
  list(projectName: string, limit: number = 10): SessionData[] {
    const db = this._getDb(projectName);
    const results = db.exec(`
      SELECT * FROM snapshots
      WHERE project_name = ?
      ORDER BY COALESCE(ended_at, started_at) DESC
      LIMIT ?
    `, [projectName, limit]);

    if (results.length === 0 || !results[0]) return [];
    return results[0].values.map(row => this._resultToSession(results[0]!.columns, row));
  }

  /** Search snapshots by keyword (LIKE-based) */
  search(query: string, projectName: string, limit: number = 10): ScoredSession[] {
    const db = this._getDb(projectName);
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => `(LOWER(keys) LIKE ? OR LOWER(context) LIKE ?)`).join(' AND ');
    const params: SqlJsValue[] = [];
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`);
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
    return results[0].values
      .map(row => {
        const session = this._resultToSession(results[0]!.columns, row);
        const text = JSON.stringify(session).toLowerCase();
        const _score = keywords.reduce((sum, kw) => {
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return sum + (text.match(new RegExp(escaped, 'g')) || []).length;
        }, 0);
        return { ...session, _score } as ScoredSession;
      })
      .sort((a, b) => b._score - a._score);
  }

  /** Forgetting Curve GC — retention score determines survival */
  gc(projectName: string, maxAgeDays: number = 30, maxCount: number = 50): GCResult {
    const db = this._getDb(projectName);

    // Load all snapshots for this project
    const results = db.exec(
      'SELECT * FROM snapshots WHERE project_name = ? ORDER BY COALESCE(ended_at, started_at) DESC',
      [projectName],
    );
    if (results.length === 0 || !results[0]) return { deleted: 0 };

    const snapshots = results[0].values.map(row => this._resultToSession(results[0]!.columns, row));
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    let deleted = 0;
    const survivors: Array<{ snap: SessionData; score: number }> = [];
    const DECAY_RATE = 0.05;

    for (const snap of snapshots) {
      const ts = new Date(snap.endedAt || snap.startedAt).getTime();

      // Hard cutoff: delete if older than maxAgeDays
      if (ts < cutoff) {
        db.run('DELETE FROM snapshots WHERE id = ?', [snap.id]);
        deleted++;
        continue;
      }

      // Forgetting Curve retention score
      const importance = snap.importance ?? 0.5;
      const accessCount = snap.accessCount || 0;
      const lastAccessed = snap.lastAccessed || snap.endedAt || snap.startedAt;
      const ageMs = Date.now() - new Date(lastAccessed).getTime();
      const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
      const score = Math.min(1.0, importance * (1 + Math.log2(1 + accessCount)) * Math.exp(-DECAY_RATE * ageDays));

      survivors.push({ snap, score });
    }

    // Enforce maxCount: remove lowest-scored snapshots
    if (survivors.length > maxCount) {
      survivors.sort((a, b) => a.score - b.score);
      const excess = survivors.slice(0, survivors.length - maxCount);
      for (const { snap } of excess) {
        db.run('DELETE FROM snapshots WHERE id = ?', [snap.id]);
        deleted++;
      }
    }

    if (deleted > 0) this._persist(projectName);
    return { deleted };
  }

  private _resultToSession(columns: string[], values: SqlJsValue[]): SessionData {
    const row: Record<string, SqlJsValue> = {};
    columns.forEach((col, i) => { row[col] = values[i] ?? null; });

    return {
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
      accessCount: 0,
      lastAccessed: String(row.ended_at || row.started_at || ''),
      importance: 0.5,
      tier: 'warm',
    };
  }

  /** Close all connections and persist */
  dispose(): void {
    for (const [name, entry] of Object.entries(this._dbs)) {
      this._persist(name);
      try { entry.db.close(); } catch { /* ignore */ }
    }
    this._dbs = {};
  }

  /** Migrate JSON snapshots to SQLite */
  migrateFromJson(jsonBaseDir: string, projectName: string): { migrated: number; errors: number } {
    const projectDir = path.join(jsonBaseDir, projectName);
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
          this.save(JSON.parse(raw) as SessionInput);
          migrated++;
        } catch { errors++; }
      }
    }

    return { migrated, errors };
  }
}
