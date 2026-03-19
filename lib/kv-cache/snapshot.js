// Soul KV-Cache — Snapshot engine. Creates/restores session snapshots from disk.
const fs = require('fs');
const path = require('path');
const { createSession, migrateSession } = require('./schema');
const { logError } = require('../utils');

/**
 * Snapshot engine for session persistence.
 * Stores compressed session snapshots to disk with date-based organization.
 */
class SnapshotEngine {
    /**
     * @param {string} baseDir - Base directory for snapshots (e.g., data/kv-cache/snapshots)
     */
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    /**
     * Save a session snapshot to disk.
     *
     * @param {object} session - Normalized session object from schema.js
     * @returns {string} Snapshot ID
     */
    save(session) {
        const s = createSession(session);
        s.endedAt = s.endedAt || new Date().toISOString();

        const dateStr = s.endedAt.split('T')[0];
        const dir = path.join(this.baseDir, s.projectName, dateStr);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const fileName = `${s.id}.json`;
        const filePath = path.join(dir, fileName);

        fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf-8');
        return s.id;
    }

    /**
     * Load the most recent snapshot for a project.
     *
     * @param {string} projectName
     * @returns {object|null} Session object or null
     */
    loadLatest(projectName) {
        const snapshots = this.list(projectName, 1);
        return snapshots.length > 0 ? snapshots[0] : null;
    }

    /**
     * Load a specific snapshot by ID.
     *
     * @param {string} projectName
     * @param {string} snapshotId
     * @returns {object|null}
     */
    loadById(projectName, snapshotId) {
        const projectDir = path.join(this.baseDir, projectName);
        if (!fs.existsSync(projectDir)) return null;

        // Search through date directories
        const dateDirs = this._getDateDirs(projectDir);
        for (const dateDir of dateDirs) {
            const filePath = path.join(dateDir, `${snapshotId}.json`);
            if (fs.existsSync(filePath)) {
                return this._readSnapshot(filePath);
            }
        }
        return null;
    }

    /**
     * List snapshots for a project, sorted by recency.
     *
     * @param {string} projectName
     * @param {number} limit - Max results
     * @returns {object[]} Array of session objects
     */
    list(projectName, limit = 10) {
        const projectDir = path.join(this.baseDir, projectName);
        if (!fs.existsSync(projectDir)) return [];

        const dateDirs = this._getDateDirs(projectDir);
        const all = [];

        for (const dateDir of dateDirs) {
            try {
                const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.json'));
                for (const file of files) {
                    const snap = this._readSnapshot(path.join(dateDir, file));
                    if (snap) all.push(snap);
                }
            } catch (e) { logError('snapshot:list', e); }
        }

        // Sort by endedAt descending (most recent first)
        all.sort((a, b) => {
            const ta = new Date(b.endedAt || b.startedAt).getTime();
            const tb = new Date(a.endedAt || a.startedAt).getTime();
            return ta - tb;
        });

        return all.slice(0, limit);
    }

    /**
     * Search snapshots by keyword.
     *
     * @param {string} query - Space-separated keywords
     * @param {string} projectName
     * @param {number} limit
     * @returns {object[]} Matching snapshots with scores
     */
    search(query, projectName, limit = 10) {
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
        const snapshots = this.list(projectName, 100);

        const scored = snapshots.map(snap => {
            let score = 0;
            const text = [
                snap.context?.summary || '',
                ...(snap.keys || []),
                ...(snap.context?.decisions || []),
            ].join(' ').toLowerCase();

            for (const kw of keywords) {
                const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const matches = (text.match(new RegExp(escaped, 'g')) || []).length;
                score += matches;
            }

            return { ...snap, _score: score };
        });

        return scored
            .filter(s => s._score > 0)
            .sort((a, b) => b._score - a._score)
            .slice(0, limit);
    }

    /**
     * Garbage collect old snapshots.
     *
     * @param {string} projectName
     * @param {number} maxAgeDays - Delete snapshots older than N days
     * @param {number} maxCount - Keep at most N snapshots
     * @returns {{ deleted: number }}
     */
    gc(projectName, maxAgeDays = 30, maxCount = 50) {
        const snapshots = this.list(projectName, 9999);
        let deleted = 0;
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

        // Delete by age
        for (const snap of snapshots) {
            const ts = new Date(snap.endedAt || snap.startedAt).getTime();
            if (ts < cutoff) {
                this._deleteSnapshot(snap);
                deleted++;
            }
        }

        // Delete excess (keep most recent maxCount)
        const remaining = this.list(projectName, 9999);
        if (remaining.length > maxCount) {
            const excess = remaining.slice(maxCount);
            for (const snap of excess) {
                this._deleteSnapshot(snap);
                deleted++;
            }
        }

        return { deleted };
    }

    // -- Private helpers --

    _readSnapshot(filePath) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            return migrateSession(JSON.parse(raw));
        } catch (e) {
            logError('snapshot:read', `${path.basename(filePath)}: ${e.message}`);
            return null;
        }
    }

    _deleteSnapshot(snap) {
        const dateStr = (snap.endedAt || snap.startedAt || '').split('T')[0];
        if (!dateStr) return;
        const filePath = path.join(this.baseDir, snap.projectName, dateStr, `${snap.id}.json`);
        try { fs.unlinkSync(filePath); } catch (e) { logError('snapshot:delete', e); }
    }

    _getDateDirs(projectDir) {
        try {
            return fs.readdirSync(projectDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => path.join(projectDir, d.name))
                .sort()
                .reverse(); // most recent first
        } catch (e) {
            logError('snapshot:getDateDirs', e);
            return [];
        }
    }
}

module.exports = { SnapshotEngine };
