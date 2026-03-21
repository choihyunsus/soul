// backup.js — Backup/restore/GC (following Soul's n2_kv_backup pattern)
const fs = require('fs');
const path = require('path');

class Backup {
    /**
     * @param {import('./store').Store} store
     * @param {object} config - Backup config (config.backup)
     */
    constructor(store, config) {
        this._store = store;
        this._config = config;
        this._metaPath = path.join(store.backupDir, 'backups.json');
    }

    /**
     * Backup current DB
     * @param {string} [label] - Human-readable label
     * @param {string} [trigger] - Trigger type (manual, pre-reindex, scheduled, pre-migration)
     * @returns {Promise<{id:string, filename:string, size:number}>}
     */
    async create(label, trigger = 'manual') {
        fs.mkdirSync(this._store.backupDir, { recursive: true });

        const id = this._generateId();
        const filename = `context-${id}.db`;
        const dest = path.join(this._store.backupDir, filename);

        // better-sqlite3 .backup() — online backup, minimal locking
        await this._store.db.backup(dest);

        const size = fs.statSync(dest).size;
        const stats = this._store.getStats();

        // Record metadata
        const meta = this._loadMeta();
        meta.backups.push({
            id,
            filename,
            label: label || null,
            trigger,
            created_at: new Date().toISOString(),
            file_count: stats.fileCount,
            chunk_count: stats.chunkCount,
            size_bytes: size,
        });
        this._saveMeta(meta);

        // Auto GC (when exceeding max count)
        await this.gc();

        return { id, filename, size, files: stats.fileCount, chunks: stats.chunkCount };
    }

    /**
     * Restore from backup
     * @param {string} [backupId] - Backup ID (defaults to latest)
     */
    async restore(backupId) {
        const meta = this._loadMeta();
        let entry;

        if (backupId) {
            entry = meta.backups.find(b => b.id === backupId);
        } else {
            entry = meta.backups[meta.backups.length - 1]; // latest
        }

        if (!entry) {
            throw new Error(`Backup not found: ${backupId || 'latest'}`);
        }

        const src = path.join(this._store.backupDir, entry.filename);
        if (!fs.existsSync(src)) {
            throw new Error(`Backup file missing: ${entry.filename}`);
        }

        // Close DB → replace with backup → reopen
        this._store.close();
        fs.copyFileSync(src, this._store.dbPath);

        // Store needs re-initialization (caller's responsibility)
        return { restored: entry.id, label: entry.label, files: entry.file_count };
    }

    /**
     * List backups
     */
    list() {
        const meta = this._loadMeta();
        return meta.backups.map(b => ({
            id: b.id,
            label: b.label,
            trigger: b.trigger,
            created_at: b.created_at,
            files: b.file_count,
            chunks: b.chunk_count,
            sizeMB: (b.size_bytes / 1024 / 1024).toFixed(2),
        }));
    }

    /**
     * Search within backup DB (ATTACH DATABASE)
     * @param {string} backupId - Backup ID
     * @param {string} query - Search query
     * @param {number} [limit=10]
     */
    searchBackup(backupId, query, limit = 10) {
        const meta = this._loadMeta();
        const entry = meta.backups.find(b => b.id === backupId);
        if (!entry) throw new Error(`Backup not found: ${backupId}`);

        const backupPath = path.join(this._store.backupDir, entry.filename);
        if (!fs.existsSync(backupPath)) throw new Error(`Backup file missing: ${entry.filename}`);

        const db = this._store.db;
        const safeAlias = 'bk_' + backupId.replace(/[^a-z0-9]/gi, '_');

        db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS ${safeAlias}`);
        try {
            const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
            if (terms.length === 0) return [];

            const conditions = terms.map(() => `LOWER(search_text) LIKE ?`).join(' AND ');
            const params = terms.map(t => `%${t}%`);

            return db.prepare(`
                SELECT *, '${backupId}' as backup_id
                FROM ${safeAlias}.chunks
                WHERE ${conditions}
                LIMIT ?
            `).all(...params, limit);
        } finally {
            db.exec(`DETACH DATABASE ${safeAlias}`);
        }
    }

    /**
     * GC: Delete old/excess backups
     */
    async gc(maxAgeDays, maxCount) {
        const maxAge = maxAgeDays || this._config.maxAgeDays || 30;
        const maxBackups = maxCount || this._config.maxBackups || 10;
        const meta = this._loadMeta();
        let removed = 0;
        const cutoff = Date.now() - maxAge * 86400000;

        // Delete old backups
        meta.backups = meta.backups.filter(b => {
            const age = new Date(b.created_at).getTime();
            if (age < cutoff) {
                this._deleteBackupFile(b.filename);
                removed++;
                return false;
            }
            return true;
        });

        // Delete excess backups (oldest first)
        while (meta.backups.length > maxBackups) {
            const oldest = meta.backups.shift();
            this._deleteBackupFile(oldest.filename);
            removed++;
        }

        this._saveMeta(meta);
        return removed;
    }

    /**
     * Export backup to external path
     */
    exportTo(externalDir) {
        if (!externalDir) return null;
        fs.mkdirSync(externalDir, { recursive: true });

        const meta = this._loadMeta();
        if (meta.backups.length === 0) return null;

        const latest = meta.backups[meta.backups.length - 1];
        const src = path.join(this._store.backupDir, latest.filename);
        const dest = path.join(externalDir, latest.filename);

        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            // Copy metadata too
            fs.copyFileSync(this._metaPath, path.join(externalDir, 'backups.json'));
            return { exported: latest.id, dest };
        }
        return null;
    }

    // ── Private ──

    _generateId() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    _loadMeta() {
        if (!fs.existsSync(this._metaPath)) {
            return { backups: [] };
        }
        return JSON.parse(fs.readFileSync(this._metaPath, 'utf-8'));
    }

    _saveMeta(meta) {
        fs.writeFileSync(this._metaPath, JSON.stringify(meta, null, 2));
    }

    _deleteBackupFile(filename) {
        const filePath = path.join(this._store.backupDir, filename);
        try { fs.unlinkSync(filePath); } catch { /* ignore if already gone */ }
    }
}

module.exports = { Backup };
