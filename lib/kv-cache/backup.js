// Soul KV-Cache — Backup/Restore engine. sqlite-store compatible DB backup.
const path = require('path');
const fs = require('fs');

/**
 * KV-Cache Backup Manager.
 * Backs up snapshots + embeddings into sqlite-store compatible DB.
 * Backup DBs can be loaded directly by SqliteStore (same schema).
 *
 * Backup structure:
 *   {backupDir}/{project}/
 *     backup-YYYY-MM-DD.sqlite    — directly loadable DB
 *     manifest.json                — backup history
 */
class BackupManager {
    /**
     * @param {string} dataDir - Soul data directory (config.DATA_DIR)
     * @param {object} config - backup config section
     */
    constructor(dataDir, config = {}) {
        this.dataDir = dataDir;
        this.backupDir = config.dir || path.join(dataDir, 'kv-cache', 'backups');
        this.keepCount = config.keepCount || 7;
        this.incremental = config.incremental !== false;
        this._SQL = null;
    }

    /**
     * Lazy-init sql.js (shared with sqlite-store).
     * @returns {Promise<object>}
     */
    async _initSql() {
        if (this._SQL) return this._SQL;
        const { initSqlJs } = require('./sqlite-store');
        this._SQL = await initSqlJs();
        return this._SQL;
    }

    /**
     * Backup: dump all project data into a sqlite-store compatible DB.
     * JSON backend: reads from snapshots folder and INSERTs into DB.
     * SQLite backend: direct .sqlite file copy (fastest).
     *
     * @param {string} project
     * @param {object} options
     * @param {boolean} options.full - Force full backup
     * @returns {Promise<object>}
     */
    async backup(project, options = {}) {
        const projectBackupDir = path.join(this.backupDir, project);
        if (!fs.existsSync(projectBackupDir)) fs.mkdirSync(projectBackupDir, { recursive: true });

        const manifest = this._loadManifest(project);

        // 1) SQLite backend: direct .sqlite file copy (instant)
        const sqlitePath = path.join(this.dataDir, 'kv-cache', 'sqlite', `${project}.sqlite`);
        if (fs.existsSync(sqlitePath)) {
            return this._backupByCopy(project, sqlitePath, manifest, options);
        }

        // 2) JSON backend: convert snapshots → DB
        return this._backupFromJson(project, manifest, options);
    }

    /**
     * SQLite backend backup: file copy (same schema, directly loadable).
     */
    _backupByCopy(project, sqlitePath, manifest, options) {
        // Incremental check
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

        const entry = { id: backupId, type: 'copy', timestamp: new Date().toISOString(), sizeBytes: stat.size };
        manifest.backups.push(entry);
        manifest.lastBackup = entry.timestamp;
        this._saveManifest(project, manifest);
        this._cleanup(project);

        return {
            backupId, type: 'copy', sizeBytes: stat.size,
            sizeFormatted: this._formatBytes(stat.size),
            path: destPath,
        };
    }

    /**
     * JSON backend backup: convert snapshots folder → sqlite-store compatible DB.
     */
    async _backupFromJson(project, manifest, options) {
        const SQL = await this._initSql();
        const snapDir = path.join(this.dataDir, 'kv-cache', 'snapshots', project);

        if (!fs.existsSync(snapDir)) {
            return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'empty', error: 'No snapshots' };
        }

        // Collect JSON files (recursive — JSON backend uses {project}/{date}/*.json)
        const snapFiles = [];
        const scanDir = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    scanDir(path.join(dir, entry.name));
                } else if (entry.name.endsWith('.json')) {
                    snapFiles.push(path.join(dir, entry.name));
                }
            }
        };
        scanDir(snapDir);

        if (snapFiles.length === 0) {
            return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'empty', error: 'No snapshots' };
        }

        // Incremental check
        if (!options.full && manifest.lastBackup) {
            const lastTime = new Date(manifest.lastBackup).getTime();
            const hasChanges = snapFiles.some(f => {
                try { return fs.statSync(f).mtimeMs > lastTime; } catch (e) { return true; }
            });
            if (!hasChanges) {
                return { backupId: null, snapshots: 0, sizeBytes: 0, type: 'skip', message: 'No changes' };
            }
        }

        // Create DB with sqlite-store compatible schema
        const db = new SQL.Database();
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

        // Embeddings table (bonus — also backed up)
        db.run(`
            CREATE TABLE IF NOT EXISTS embeddings (
                snapshot_id TEXT PRIMARY KEY,
                vector BLOB NOT NULL
            )
        `);

        // Insert snapshots
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO snapshots
            (id, agent_name, agent_type, model, started_at, ended_at,
             turn_count, token_estimate, keys, context, parent_session_id, project_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let snapCount = 0;
        for (const filePath of snapFiles) {
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const s = JSON.parse(raw);
                stmt.run([
                    s.id, s.agentName || 'unknown', s.agentType || 'external', s.model || null,
                    s.startedAt || null, s.endedAt || null,
                    s.turnCount || 0, s.tokenEstimate || 0,
                    JSON.stringify(s.keys || []), JSON.stringify(s.context || {}),
                    s.parentSessionId || null, s.projectName || project,
                ]);
                snapCount++;
            } catch (e) { /* skip corrupt */ }
        }
        stmt.free();

        // Insert embeddings
        const embDir = path.join(this.dataDir, 'kv-cache', 'embeddings', project);
        let embCount = 0;
        if (fs.existsSync(embDir)) {
            const embStmt = db.prepare('INSERT OR REPLACE INTO embeddings (snapshot_id, vector) VALUES (?, ?)');
            for (const file of fs.readdirSync(embDir).filter(f => f.endsWith('.json'))) {
                try {
                    const vec = fs.readFileSync(path.join(embDir, file), 'utf-8');
                    embStmt.run([path.basename(file, '.json'), vec]);
                    embCount++;
                } catch (e) { /* skip */ }
            }
            embStmt.free();
        }

        // Write DB to disk
        const backupId = this._makeBackupId();
        const destPath = path.join(this.backupDir, project, `backup-${backupId}.sqlite`);
        const dbData = db.export();
        const buffer = Buffer.from(dbData);
        fs.writeFileSync(destPath, buffer);
        db.close();

        const entry = {
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

    /**
     * Restore from backup. Copies backup DB to sqlite-store location,
     * or extracts from DB back to JSON files for JSON backend.
     *
     * @param {string} project
     * @param {string} backupId
     * @param {object} options
     * @param {string} options.target - 'sqlite' | 'json' (default: 'json')
     * @returns {Promise<object>}
     */
    async restore(project, backupId = null, options = {}) {
        const manifest = this._loadManifest(project);
        if (!backupId) {
            if (manifest.backups.length === 0) return { error: 'No backups found', restored: 0 };
            backupId = manifest.backups[manifest.backups.length - 1].id;
        }

        const dbPath = path.join(this.backupDir, project, `backup-${backupId}.sqlite`);
        if (!fs.existsSync(dbPath)) return { error: `Backup not found: ${backupId}`, restored: 0 };

        const target = options.target || 'json';

        if (target === 'sqlite') {
            // Direct copy to sqlite-store location
            const destDir = path.join(this.dataDir, 'kv-cache', 'sqlite');
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(dbPath, path.join(destDir, `${project}.sqlite`));
            return { restored: 'full', backupId, target: 'sqlite' };
        }

        // JSON restore: extract from DB back to snapshot files
        const SQL = await this._initSql();
        const dbData = fs.readFileSync(dbPath);
        const db = new SQL.Database(dbData);

        const snapDir = path.join(this.dataDir, 'kv-cache', 'snapshots', project);
        if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });

        let restoredSnaps = 0;
        const snapRows = db.exec('SELECT * FROM snapshots');
        if (snapRows.length > 0) {
            const cols = snapRows[0].columns;
            for (const row of snapRows[0].values) {
                const obj = {};
                cols.forEach((c, i) => { obj[c] = row[i]; });
                const session = {
                    id: obj.id, agentName: obj.agent_name, agentType: obj.agent_type,
                    model: obj.model, startedAt: obj.started_at, endedAt: obj.ended_at,
                    turnCount: obj.turn_count, tokenEstimate: obj.token_estimate,
                    keys: JSON.parse(obj.keys || '[]'), context: JSON.parse(obj.context || '{}'),
                    parentSessionId: obj.parent_session_id, projectName: obj.project_name,
                };
                fs.writeFileSync(path.join(snapDir, `${session.id}.json`), JSON.stringify(session, null, 2));
                restoredSnaps++;
            }
        }

        // Embeddings
        const embDir = path.join(this.dataDir, 'kv-cache', 'embeddings', project);
        if (!fs.existsSync(embDir)) fs.mkdirSync(embDir, { recursive: true });
        let restoredEmbs = 0;
        const embRows = db.exec('SELECT snapshot_id, vector FROM embeddings');
        if (embRows.length > 0) {
            for (const row of embRows[0].values) {
                fs.writeFileSync(path.join(embDir, `${row[0]}.json`), row[1]);
                restoredEmbs++;
            }
        }

        db.close();
        return { restored: restoredSnaps, embeddings: restoredEmbs, backupId, target: 'json' };
    }

    /** List backup history. */
    list(project) {
        return this._loadManifest(project).backups.map(b => ({
            ...b, sizeFormatted: this._formatBytes(b.sizeBytes),
        }));
    }

    /** Backup status summary. */
    status(project) {
        const manifest = this._loadManifest(project);
        const totalSize = manifest.backups.reduce((s, b) => s + (b.sizeBytes || 0), 0);
        return {
            project, totalBackups: manifest.backups.length,
            lastBackup: manifest.lastBackup, totalBackupSize: this._formatBytes(totalSize),
            keepCount: this.keepCount,
        };
    }

    // ── Helpers ──

    _cleanup(project) {
        const manifest = this._loadManifest(project);
        const dir = path.join(this.backupDir, project);
        let deleted = 0;
        while (manifest.backups.length > this.keepCount) {
            const old = manifest.backups.shift();
            try { fs.unlinkSync(path.join(dir, `backup-${old.id}.sqlite`)); deleted++; } catch (e) { }
        }
        if (deleted > 0) this._saveManifest(project, manifest);
        return { deleted };
    }

    _makeBackupId() {
        return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    _loadManifest(project) {
        const p = path.join(this.backupDir, project, 'manifest.json');
        try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { }
        return { backups: [], lastBackup: null };
    }

    _saveManifest(project, manifest) {
        const dir = path.join(this.backupDir, project);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    _formatBytes(bytes) {
        if (!bytes) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
    }
}

module.exports = { BackupManager };
