// store.js — SQLite DB management (schema creation, migration, basic queries)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
-- Meta information (version, project path, etc.)
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- File index
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    language TEXT,
    size_bytes INTEGER,
    chunk_count INTEGER DEFAULT 0,
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME
);

-- Code chunks (function/class/block level)
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_type TEXT NOT NULL,
    name TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    search_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Search indexes
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
`;

// Phase 2 schema — dependency graph + access history
const SCHEMA_V2_SQL = `
-- Dependency graph (import/require relationships)
CREATE TABLE IF NOT EXISTS dependencies (
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    target_path TEXT NOT NULL,
    target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    dep_type TEXT DEFAULT 'import',
    PRIMARY KEY (source_file_id, target_path)
);

-- Access history (track frequently used files)
CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    query TEXT,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file_id);
CREATE INDEX IF NOT EXISTS idx_access_file ON access_log(file_id);
CREATE INDEX IF NOT EXISTS idx_access_time ON access_log(accessed_at);
`;

// Phase 3 schema — embedding metadata (vectors stored in sqlite-vec vec0 table)
const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS embeddings_meta (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT DEFAULT 'nomic-embed-text',
    dimensions INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

class Store {
    /**
     * @param {string} dataDir - Data directory path
     */
    constructor(dataDir) {
        this._dataDir = dataDir;
        this._dbPath = path.join(dataDir, 'context.db');
        this._backupDir = path.join(dataDir, 'backups');
        this._db = null;
    }

    /** Initialize DB (create directories + apply schema) */
    async init() {
        // Create directories
        fs.mkdirSync(this._dataDir, { recursive: true });
        fs.mkdirSync(this._backupDir, { recursive: true });

        // SQLite connection
        this._db = new Database(this._dbPath);

        // WAL mode (improved concurrency)
        this._db.pragma('journal_mode = WAL');
        // Enable foreign keys
        this._db.pragma('foreign_keys = ON');

        // Apply schema
        this._db.exec(SCHEMA_SQL);

        // Run migrations
        this._migrate();

        // Record version
        this._setMeta('schema_version', String(SCHEMA_VERSION));
        this._setMeta('created_at', new Date().toISOString());
    }

    /** Migration (v1→v2→v3) */
    _migrate() {
        const currentVersion = Number(this.getMeta('schema_version') || '1');
        if (currentVersion < 2) {
            this._db.exec(SCHEMA_V2_SQL);
        }
        if (currentVersion < 3) {
            this._db.exec(SCHEMA_V3_SQL);
        }
    }

    /** DB instance */
    get db() { return this._db; }

    /** DB file path */
    get dbPath() { return this._dbPath; }

    /** Backup directory */
    get backupDir() { return this._backupDir; }

    // ── Meta ──

    _setMeta(key, value) {
        this._db.prepare(`
            INSERT INTO meta (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, value);
    }

    getMeta(key) {
        const row = this._db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    // ── Files ──

    /**
     * File upsert (compare hash if exists, then update)
     * @returns {{ action: 'inserted'|'updated'|'skipped', fileId: number }}
     */
    upsertFile(relativePath, hash, language, sizeBytes, modifiedAt) {
        const existing = this._db.prepare('SELECT id, hash FROM files WHERE path = ?').get(relativePath);

        if (existing) {
            if (existing.hash === hash) {
                return { action: 'skipped', fileId: existing.id };
            }
            // Hash changed → delete chunks then update file
            this._db.prepare('DELETE FROM chunks WHERE file_id = ?').run(existing.id);
            this._db.prepare(`
                UPDATE files SET hash = ?, language = ?, size_bytes = ?,
                    chunk_count = 0, indexed_at = datetime('now'), modified_at = ?
                WHERE id = ?
            `).run(hash, language, sizeBytes, modifiedAt, existing.id);
            return { action: 'updated', fileId: existing.id };
        }

        const result = this._db.prepare(`
            INSERT INTO files (path, hash, language, size_bytes, modified_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(relativePath, hash, language, sizeBytes, modifiedAt);
        return { action: 'inserted', fileId: result.lastInsertRowid };
    }

    /** Insert chunks for a file */
    insertChunks(fileId, chunks) {
        const stmt = this._db.prepare(`
            INSERT INTO chunks (file_id, chunk_type, name, start_line, end_line, content, token_count, search_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this._db.transaction((items) => {
            for (const c of items) {
                stmt.run(fileId, c.type, c.name, c.startLine, c.endLine, c.content, c.tokenCount, c.searchText);
            }
        });

        insertMany(chunks);

        // Update file's chunk_count
        this._db.prepare('UPDATE files SET chunk_count = ? WHERE id = ?').run(chunks.length, fileId);
    }

    /** Delete file (CASCADE deletes chunks) */
    removeFile(relativePath) {
        return this._db.prepare('DELETE FROM files WHERE path = ?').run(relativePath);
    }

    /** Get file by path */
    getFileByPath(relativePath) {
        return this._db.prepare('SELECT * FROM files WHERE path = ?').get(relativePath);
    }

    /** Get all indexed files */
    getAllFiles(language) {
        if (language) {
            return this._db.prepare('SELECT * FROM files WHERE language = ? ORDER BY path').all(language);
        }
        return this._db.prepare('SELECT * FROM files ORDER BY path').all();
    }

    /** Get chunks belonging to a file */
    getChunksByFileId(fileId) {
        return this._db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY start_line').all(fileId);
    }

    // ── Search ──

    /** LIKE search in search_text (simple keyword search) */
    searchChunks(query, limit = 10) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return [];

        // Find chunks containing all search terms
        const conditions = terms.map(() => "LOWER(c.search_text) LIKE ?").join(' AND ');
        const params = terms.map(t => `%${t}%`);

        return this._db.prepare(`
            SELECT c.*, f.path as file_path, f.language
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE ${conditions}
            ORDER BY c.token_count ASC
            LIMIT ?
        `).all(...params, limit);
    }

    // ── Stats ──

    getStats() {
        const fileCount = this._db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt;
        const chunkCount = this._db.prepare('SELECT COUNT(*) as cnt FROM chunks').get().cnt;
        const totalTokens = this._db.prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM chunks').get().total;
        const languages = this._db.prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language ORDER BY cnt DESC').all();

        let dbSize = 0;
        try { dbSize = fs.statSync(this._dbPath).size; } catch { /* ignore */ }

        return {
            fileCount,
            chunkCount,
            totalTokens,
            languages,
            dbSizeBytes: dbSize,
            dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
            lastIndexed: this.getMeta('last_indexed_at'),
            schemaVersion: this.getMeta('schema_version'),
        };
    }

    // ── Stale file cleanup ──

    /** Remove files that no longer exist on disk */
    cleanStaleFiles(projectDir) {
        const allFiles = this._db.prepare('SELECT id, path FROM files').all();
        let removed = 0;

        const deleteStmt = this._db.prepare('DELETE FROM files WHERE id = ?');
        const cleanTransaction = this._db.transaction((files) => {
            for (const f of files) {
                const fullPath = path.join(projectDir, f.path);
                if (!fs.existsSync(fullPath)) {
                    deleteStmt.run(f.id);
                    removed++;
                }
            }
        });

        cleanTransaction(allFiles);
        return removed;
    }

    // ── Dependencies (Phase 2) ──

    /** Batch save file dependencies */
    insertDependencies(fileId, deps) {
        const stmt = this._db.prepare(`
            INSERT OR REPLACE INTO dependencies (source_file_id, target_path, target_file_id, dep_type)
            VALUES (?, ?, ?, ?)
        `);
        const insertMany = this._db.transaction((items) => {
            for (const d of items) {
                stmt.run(fileId, d.targetPath, d.targetFileId || null, d.depType || 'import');
            }
        });
        insertMany(deps);
    }

    /** Clear file dependencies */
    clearDependencies(fileId) {
        this._db.prepare('DELETE FROM dependencies WHERE source_file_id = ?').run(fileId);
    }

    /** Get direct dependencies (depth=1) */
    getDirectDependencies(fileId) {
        return this._db.prepare(`
            SELECT d.*, f.path as target_resolved_path
            FROM dependencies d
            LEFT JOIN files f ON d.target_file_id = f.id
            WHERE d.source_file_id = ?
        `).all(fileId);
    }

    /** Recursive dependency traversal (depth-limited BFS) */
    getTransitiveDependencies(fileId, maxDepth = 2) {
        const visited = new Set();
        const result = [];
        let queue = [{ fileId, depth: 0 }];

        while (queue.length > 0) {
            const { fileId: fid, depth } = queue.shift();
            if (visited.has(fid) || depth >= maxDepth) continue;
            visited.add(fid);

            const deps = this.getDirectDependencies(fid);
            for (const dep of deps) {
                result.push({ ...dep, depth: depth + 1 });
                if (dep.target_file_id && !visited.has(dep.target_file_id)) {
                    queue.push({ fileId: dep.target_file_id, depth: depth + 1 });
                }
            }
        }
        return result;
    }

    /** Reverse dependencies: files that import this file */
    getReverseDependencies(fileId) {
        return this._db.prepare(`
            SELECT d.*, f.path as source_path
            FROM dependencies d
            JOIN files f ON d.source_file_id = f.id
            WHERE d.target_file_id = ?
        `).all(fileId);
    }

    // ── Access Log (Phase 2) ──

    /** Record file access */
    logAccess(fileId, query) {
        this._db.prepare(`
            INSERT INTO access_log (file_id, query) VALUES (?, ?)
        `).run(fileId, query || null);
    }

    /** Recent accessed files (deduplicated, newest first) */
    getRecentFiles(limit = 10) {
        return this._db.prepare(`
            SELECT DISTINCT a.file_id, f.path, MAX(a.accessed_at) as last_access
            FROM access_log a
            JOIN files f ON a.file_id = f.id
            GROUP BY a.file_id
            ORDER BY last_access DESC
            LIMIT ?
        `).all(limit);
    }

    /** Most frequently accessed files (by count) */
    getMostAccessedFiles(limit = 5) {
        return this._db.prepare(`
            SELECT a.file_id, f.path, COUNT(*) as access_count
            FROM access_log a
            JOIN files f ON a.file_id = f.id
            GROUP BY a.file_id
            ORDER BY access_count DESC
            LIMIT ?
        `).all(limit);
    }

    /** Batch query chunks for multiple files */
    getChunksByFileIds(fileIds) {
        if (!fileIds || fileIds.length === 0) return [];
        const placeholders = fileIds.map(() => '?').join(',');
        return this._db.prepare(`
            SELECT c.*, f.path as file_path, f.language
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.file_id IN (${placeholders})
            ORDER BY c.file_id, c.start_line
        `).all(...fileIds);
    }

    /** Clean old access log entries */
    cleanAccessLog(maxAgeDays = 30) {
        const result = this._db.prepare(`
            DELETE FROM access_log
            WHERE accessed_at < datetime('now', '-' || ? || ' days')
        `).run(maxAgeDays);
        return result.changes;
    }

    /** Close DB connection */
    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }
}

module.exports = { Store };
