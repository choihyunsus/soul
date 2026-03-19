// Soul KV-Cache — SQLite storage engine (pure JS via sql.js). No native dependencies.
const fs = require('fs');
const path = require('path');
const { createSession } = require('./schema');

// Module-level singleton: sql.js SQL module (loaded once via async init)
let _SQL = null;
let _sqlInitPromise = null;

/**
 * Initialize sql.js module once.
 * @returns {Promise<object>} sql.js module with Database constructor
 */
async function initSqlJs() {
    if (_SQL) return _SQL;
    if (_sqlInitPromise) return _sqlInitPromise;

    _sqlInitPromise = (async () => {
        const initFn = require('sql.js');
        _SQL = await initFn();
        return _SQL;
    })();

    return _sqlInitPromise;
}

/**
 * Get sql.js module synchronously (must call initSqlJs() first).
 * @returns {object|null}
 */
function getSqlSync() {
    return _SQL;
}

/**
 * SQLite-backed snapshot storage using sql.js (pure JavaScript WASM).
 * No native compilation — works with any Node.js version.
 *
 * Architecture:
 * - Module-level async init for sql.js WASM (once per process)
 * - Per-project SQLite files at {baseDir}/{project}.sqlite
 * - LIKE-based search (FTS5 not available in default WASM build)
 * - Auto-persist on every write operation
 */
class SqliteStore {
    /**
     * @param {string} baseDir - Base directory for SQLite databases
     */
    constructor(baseDir) {
        this.baseDir = baseDir;
        this._dbs = {};     // { projectName: { db, dirty, path } }
        this._ready = false;
    }

    /**
     * Async initialization. Must be called before any operations.
     * Safe to call multiple times.
     */
    async init() {
        if (this._ready) return;
        await initSqlJs();
        this._ready = true;
    }

    /**
     * Ensure the module is initialized. Throws if not ready.
     */
    _assertReady() {
        if (!_SQL) {
            // Try sync fallback — will work after first async init
            throw new Error('SqliteStore not initialized. Call init() first or use ensureReady().');
        }
    }

    /**
     * Ensure ready and get/create DB for project.
     * @param {string} projectName
     * @returns {object} sql.js Database
     */
    _getDb(projectName) {
        if (this._dbs[projectName]) return this._dbs[projectName].db;

        this._assertReady();
        const dbPath = path.join(this.baseDir, `${projectName}.sqlite`);

        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }

        let db;
        if (fs.existsSync(dbPath)) {
            const buffer = fs.readFileSync(dbPath);
            db = new _SQL.Database(buffer);
        } else {
            db = new _SQL.Database();
        }

        // Schema: separation of concerns — tool-catalog gets tools only, others get snapshots only
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
            db.run(`
                CREATE INDEX IF NOT EXISTS idx_snapshots_project
                    ON snapshots(project_name, ended_at DESC)
            `);
        }

        if (isToolCatalog) {
            // Tools table — only for dedicated tool catalog DB
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

    /**
     * Persist database to disk.
     * @param {string} projectName
     */
    _persist(projectName) {
        const entry = this._dbs[projectName];
        if (!entry) return;
        const data = entry.db.export();
        fs.writeFileSync(entry.path, Buffer.from(data));
        entry.dirty = false;
    }

    /**
     * Save a session snapshot.
     * @param {object} session - Normalized session from schema.js
     * @returns {string} Snapshot ID
     */
    save(session) {
        const s = createSession(session);
        s.endedAt = s.endedAt || new Date().toISOString();

        const db = this._getDb(s.projectName);
        const keys = JSON.stringify(s.keys);
        const context = JSON.stringify(s.context);

        db.run(`
            INSERT OR REPLACE INTO snapshots
            (id, agent_name, agent_type, model, started_at, ended_at,
             turn_count, token_estimate, keys, context, parent_session_id, project_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            s.id, s.agentName, s.agentType, s.model,
            s.startedAt, s.endedAt,
            s.turnCount, s.tokenEstimate,
            keys, context,
            s.parentSessionId, s.projectName,
        ]);

        this._persist(s.projectName);
        return s.id;
    }

    /**
     * Load the most recent snapshot.
     * @param {string} projectName
     * @returns {object|null}
     */
    loadLatest(projectName) {
        const results = this.list(projectName, 1);
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Load a specific snapshot by ID.
     * @param {string} projectName
     * @param {string} snapshotId
     * @returns {object|null}
     */
    loadById(projectName, snapshotId) {
        const db = this._getDb(projectName);
        const results = db.exec('SELECT * FROM snapshots WHERE id = ?', [snapshotId]);
        if (results.length === 0 || results[0].values.length === 0) return null;
        return this._resultToSession(results[0].columns, results[0].values[0]);
    }

    /**
     * List snapshots sorted by recency.
     * @param {string} projectName
     * @param {number} limit
     * @returns {object[]}
     */
    list(projectName, limit = 10) {
        const db = this._getDb(projectName);
        const results = db.exec(`
            SELECT * FROM snapshots
            WHERE project_name = ?
            ORDER BY COALESCE(ended_at, started_at) DESC
            LIMIT ?
        `, [projectName, limit]);

        if (results.length === 0) return [];
        return results[0].values.map(row =>
            this._resultToSession(results[0].columns, row)
        );
    }

    /**
     * Search snapshots by keyword (LIKE-based).
     * @param {string} query - Space-separated keywords
     * @param {string} projectName
     * @param {number} limit
     * @returns {object[]}
     */
    search(query, projectName, limit = 10) {
        const db = this._getDb(projectName);
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
        if (keywords.length === 0) return [];

        const conditions = keywords.map(() =>
            `(LOWER(keys) LIKE ? OR LOWER(context) LIKE ?)`
        ).join(' AND ');

        const params = [];
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

        if (results.length === 0) return [];
        return results[0].values.map(row => {
            const session = this._resultToSession(results[0].columns, row);
            // Score by keyword match count
            const text = JSON.stringify(session).toLowerCase();
            session._score = keywords.reduce((sum, kw) => {
                const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return sum + (text.match(new RegExp(escaped, 'g')) || []).length;
            }, 0);
            return session;
        }).sort((a, b) => b._score - a._score);
    }

    /**
     * Garbage collect old snapshots.
     * @param {string} projectName
     * @param {number} maxAgeDays
     * @param {number} maxCount
     * @returns {{ deleted: number }}
     */
    gc(projectName, maxAgeDays = 30, maxCount = 50) {
        const db = this._getDb(projectName);

        // Count before
        const beforeResult = db.exec(
            'SELECT COUNT(*) FROM snapshots WHERE project_name = ?',
            [projectName]
        );
        const before = beforeResult.length > 0 ? beforeResult[0].values[0][0] : 0;

        // Delete by age
        const cutoffDate = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
        db.run(`
            DELETE FROM snapshots
            WHERE project_name = ?
            AND COALESCE(ended_at, started_at) < ?
        `, [projectName, cutoffDate]);

        // Delete excess
        db.run(`
            DELETE FROM snapshots
            WHERE project_name = ?
            AND id NOT IN (
                SELECT id FROM snapshots
                WHERE project_name = ?
                ORDER BY COALESCE(ended_at, started_at) DESC
                LIMIT ?
            )
        `, [projectName, projectName, maxCount]);

        // Count after
        const afterResult = db.exec(
            'SELECT COUNT(*) FROM snapshots WHERE project_name = ?',
            [projectName]
        );
        const after = afterResult.length > 0 ? afterResult[0].values[0][0] : 0;

        this._persist(projectName);
        return { deleted: before - after };
    }

    /**
     * Convert db.exec result row to session object.
     * @param {string[]} columns
     * @param {any[]} values
     * @returns {object}
     */
    _resultToSession(columns, values) {
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });

        return {
            id: row.id,
            agentName: row.agent_name,
            agentType: row.agent_type,
            model: row.model,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            turnCount: row.turn_count,
            tokenEstimate: row.token_estimate,
            keys: JSON.parse(row.keys || '[]'),
            context: JSON.parse(row.context || '{}'),
            parentSessionId: row.parent_session_id,
            projectName: row.project_name,
        };
    }

    /**
     * Close all connections and persist.
     */
    dispose() {
        for (const [name, entry] of Object.entries(this._dbs)) {
            this._persist(name);
            try { entry.db.close(); } catch (e) { /* ignore */ }
        }
        this._dbs = {};
    }

    /**
     * Migrate JSON snapshots to SQLite.
     * @param {string} jsonBaseDir
     * @param {string} projectName
     * @returns {{ migrated: number, errors: number }}
     */
    migrateFromJson(jsonBaseDir, projectName) {
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
                    const session = JSON.parse(raw);
                    this.save(session);
                    migrated++;
                } catch (e) {
                    errors++;
                }
            }
        }

        return { migrated, errors };
    }
}

module.exports = { SqliteStore, initSqlJs };
