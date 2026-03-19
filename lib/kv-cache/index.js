// Soul KV-Cache — Orchestrator. Coordinates snapshot, compressor, and adapter.
const path = require('path');
const fs = require('fs');
const { logError } = require('../utils');
const { SnapshotEngine } = require('./snapshot');
const { compress, decompress } = require('./compressor');
const { fromMcpSession, toResumePrompt, extractKeywords } = require('./agent-adapter');
const { createSession, migrateSession } = require('./schema');
const { extractAtLevel, autoLevel } = require('./token-saver');
const { TierManager } = require('./tier-manager');

/**
 * Creates the appropriate storage engine based on config.
 * For SQLite backend, triggers async init in background.
 *
 * @param {string} dataDir
 * @param {object} config
 * @returns {SnapshotEngine|import('./sqlite-store').SqliteStore}
 */
function createStorageEngine(dataDir, config) {
    const backend = config.backend || 'json';
    const snapshotDir = config.snapshotDir || path.join(dataDir, 'kv-cache', 'snapshots');
    let engine;

    if (backend === 'sqlite') {
        try {
            const { SqliteStore, initSqlJs } = require('./sqlite-store');
            const sqliteDir = config.sqliteDir || path.join(dataDir, 'kv-cache', 'sqlite');
            engine = new SqliteStore(sqliteDir);
            // Trigger async init in background
            initSqlJs().then(() => {
                engine._ready = true;
            }).catch(e => {
                console.error(`[kv-cache] SQLite init failed: ${e.message}`);
            });
        } catch (e) {
            logError('kv-cache:sqlite', `SQLite unavailable (${e.message}), falling back to JSON`);
            engine = new SnapshotEngine(snapshotDir);
        }
    } else {
        engine = new SnapshotEngine(snapshotDir);
    }

    // Wrap with TierManager if tier config is present
    const tierConfig = config.tier;
    if (tierConfig) {
        return new TierManager(engine, tierConfig);
    }

    return engine;
}

/**
 * Main KV-Cache orchestrator.
 * Coordinates snapshot persistence, context compression, and session management.
 */
class SoulKVCache {
    /**
     * @param {string} dataDir - Soul data directory (config.DATA_DIR)
     * @param {object} config - KV_CACHE config section
     */
    constructor(dataDir, config = {}) {
        this.snapshot = createStorageEngine(dataDir, config);
        this.dataDir = dataDir;
        this.config = {
            backend: config.backend || 'json',
            compressionTarget: config.compressionTarget || 1000,
            maxSnapshotsPerProject: config.maxSnapshotsPerProject || 50,
            maxSnapshotAgeDays: config.maxSnapshotAgeDays || 30,
            tokenBudget: config.tokenBudget || {
                bootContext: 2000,
                searchResult: 500,
                progressiveLoad: true,
            },
        };

        // Embedding engine (optional, requires Ollama)
        this.embedding = null;
        this._embeddingReady = false;
        const embConfig = config.embedding;
        if (embConfig?.enabled) {
            const { EmbeddingEngine } = require('./embedding');
            this.embedding = new EmbeddingEngine(embConfig);
            // Check availability in background (non-blocking)
            this.embedding.isAvailable().then(ok => {
                this._embeddingReady = ok;
                if (ok) {
                    logError('kv-cache:embedding', `Embedding ready: ${embConfig.model} (${this.embedding.dimensions}d)`);
                } else {
                    logError('kv-cache:embedding', 'Embedding unavailable, falling back to keyword search');
                }
            }).catch(() => {
                this._embeddingReady = false;
            });
        }

        // Backup manager (optional)
        this._backup = null;
        this._backupTimer = null;
        const backupConfig = config.backup;
        if (backupConfig?.enabled) {
            const { BackupManager } = require('./backup');
            this._backup = new BackupManager(dataDir, backupConfig);

            // Auto-backup scheduler
            const schedule = backupConfig.schedule || 'daily';
            if (schedule !== 'manual') {
                const intervalMs = schedule === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
                // First backup after 5 minutes, then on interval
                this._backupTimer = setTimeout(() => {
                    this._runAutoBackup();
                    this._backupTimer = setInterval(() => this._runAutoBackup(), intervalMs);
                }, 5 * 60 * 1000);
                logError('kv-cache:backup', `Auto-backup scheduled: ${schedule}`);
            }
        }
    }

    /**
     * Save a session snapshot with automatic compression.
     *
     * @param {string} agent - Agent name
     * @param {string} project - Project name
     * @param {object} sessionData - Raw session data (from n2_work_end or browser)
     * @returns {string} Snapshot ID
     */
    save(agent, project, sessionData) {
        // Convert MCP session data to normalized schema
        const normalized = fromMcpSession({
            agent,
            project,
            ...sessionData,
        });

        // Compress summary if it's too long
        if (normalized.context.summary) {
            const result = compress(
                normalized.context.summary,
                this.config.compressionTarget
            );
            normalized.keys = [...new Set([...normalized.keys, ...result.keys])];
            normalized.context.summary = result.compressed || normalized.context.summary;
        }

        const id = this.snapshot.save(normalized);

        // Generate embedding in background (non-blocking, fire-and-forget)
        if (this._embeddingReady && this.embedding) {
            const text = this.embedding.snapshotToText(normalized);
            this.embedding.embed(text).then(vec => {
                if (vec.length > 0) {
                    this._storeEmbedding(project, id, vec);
                }
            }).catch((e) => { logError('kv-cache:embed', e); });
        }

        return id;
    }

    /**
     * Load the most recent snapshot for a project.
     * Supports progressive loading levels (L1/L2/L3) and token budget.
     *
     * @param {string} project - Project name
     * @param {object} options
     * @param {string} options.level - Progressive level: 'L1', 'L2', 'L3', or 'auto'
     * @param {number} options.budget - Token budget for context (used with 'auto' level)
     * @returns {object|null} Session snapshot or null
     */
    load(project, options = {}) {
        const snap = this.snapshot.loadLatest(project);
        if (!snap) return null;

        const level = options.level || 'auto';
        const budget = options.budget || this.config.tokenBudget.bootContext;

        if (level === 'auto') {
            const result = autoLevel(snap, budget);
            snap._resumePrompt = result.prompt;
            snap._level = result.level;
            snap._promptTokens = result.tokens;
        } else {
            const result = extractAtLevel(snap, level);
            snap._resumePrompt = result.prompt;
            snap._level = result.level;
            snap._promptTokens = result.tokens;
        }

        return snap;
    }

    /**
     * Search across snapshots by keyword or semantic similarity.
     * When Ollama embedding is available: uses cosine similarity (semantic).
     * Otherwise: falls back to keyword-based LIKE search.
     *
     * @param {string} query
     * @param {string} project
     * @param {number} limit
     * @returns {object[]|Promise<object[]>}
     */
    search(query, project, limit = 10) {
        // Try semantic search if embedding is available
        if (this._embeddingReady && this.embedding) {
            return this._semanticSearch(query, project, limit);
        }
        // Fallback to keyword search
        return this.snapshot.search(query, project, limit);
    }

    /**
     * Semantic search using Ollama embeddings.
     * @param {string} query
     * @param {string} project
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async _semanticSearch(query, project, limit) {
        try {
            const queryVec = await this.embedding.embed(query);
            if (queryVec.length === 0) {
                // Embedding failed, fallback to keyword search
                return this.snapshot.search(query, project, limit);
            }

            // Get all snapshots and compute similarity
            const allSnaps = this.snapshot.list(project, 9999);
            const candidates = [];

            for (const snap of allSnaps) {
                const stored = this._loadEmbedding(project, snap.id);
                if (stored) {
                    candidates.push({ id: snap.id, vector: stored, snap });
                }
            }

            if (candidates.length === 0) {
                // No embeddings stored, fallback
                return this.snapshot.search(query, project, limit);
            }

            const ranked = this.embedding.rankBySimilarity(queryVec, candidates, limit, 0.2);
            return ranked.map(r => {
                const snap = candidates.find(c => c.id === r.id)?.snap;
                return { ...snap, _score: r.score, _searchMode: 'semantic' };
            });
        } catch (e) {
            logError('kv-cache:semantic-search', e);
            return this.snapshot.search(query, project, limit);
        }
    }

    /**
     * List snapshots for a project.
     *
     * @param {string} project
     * @param {number} limit
     * @returns {object[]}
     */
    listSnapshots(project, limit = 10) {
        return this.snapshot.list(project, limit);
    }

    /**
     * Garbage collect old snapshots.
     *
     * @param {string} project
     * @param {number} maxAgeDays - Override config value
     * @returns {{ deleted: number }}
     */
    gc(project, maxAgeDays) {
        const age = maxAgeDays ?? this.config.maxSnapshotAgeDays;
        return this.snapshot.gc(project, age, this.config.maxSnapshotsPerProject);
    }

    /**
     * Estimate token count for a text string.
     * Model-agnostic: uses chars/4 for ASCII, chars/2 for CJK.
     *
     * @param {string} text
     * @returns {number}
     */
    estimateTokens(text) {
        if (!text) return 0;
        const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
        const asciiCount = text.length - cjkCount;
        return Math.ceil(asciiCount / 4 + cjkCount / 2);
    }

    /**
     * Migrate JSON snapshots to SQLite for a project.
     * Only works when current backend is 'sqlite'.
     *
     * @param {string} project
     * @returns {{ migrated: number, errors: number }|{ error: string }}
     */
    migrate(project) {
        if (this.config.backend !== 'sqlite' || !this.snapshot.migrateFromJson) {
            return { error: 'Migration only available when backend is sqlite' };
        }
        const jsonDir = path.join(this.dataDir, 'kv-cache', 'snapshots');
        return this.snapshot.migrateFromJson(jsonDir, project);
    }

    /**
     * Returns current backend info for diagnostics.
     * @returns {{ backend: string, snapshotCount: number, embedding: string }}
     */
    backendInfo(project) {
        const count = this.listSnapshots(project, 9999).length;
        return {
            backend: this.config.backend,
            snapshotCount: count,
            embedding: this._embeddingReady ? `active (${this.embedding?.model})` : 'off',
        };
    }

    /**
     * Store an embedding vector to disk.
     * Vectors stored as JSON at {dataDir}/kv-cache/embeddings/{project}/{id}.json
     *
     * @param {string} project
     * @param {string} snapshotId
     * @param {number[]} vector
     */
    _storeEmbedding(project, snapshotId, vector) {
        const dir = path.join(this.dataDir, 'kv-cache', 'embeddings', project);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${snapshotId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(vector));
    }

    /**
     * Load an embedding vector from disk.
     *
     * @param {string} project
     * @param {string} snapshotId
     * @returns {number[]|null}
     */
    _loadEmbedding(project, snapshotId) {
        const filePath = path.join(this.dataDir, 'kv-cache', 'embeddings', project, `${snapshotId}.json`);
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            logError('kv-cache:load-embedding', e);
            return null;
        }
    }

    /**
     * Backup project data into a sqlite-store compatible DB.
     * @param {string} project
     * @param {object} options
     * @returns {Promise<object>}
     */
    async backup(project, options = {}) {
        if (!this._backup) {
            // Lazy init even if not enabled in config
            const { BackupManager } = require('./backup');
            this._backup = new BackupManager(this.dataDir, {});
        }
        return this._backup.backup(project, options);
    }

    /**
     * Restore from backup.
     * @param {string} project
     * @param {string} backupId
     * @param {object} options
     * @returns {Promise<object>}
     */
    async restore(project, backupId = null, options = {}) {
        if (!this._backup) {
            const { BackupManager } = require('./backup');
            this._backup = new BackupManager(this.dataDir, {});
        }
        return this._backup.restore(project, backupId, options);
    }

    /**
     * List backup history for a project.
     * @param {string} project
     * @returns {object[]}
     */
    listBackups(project) {
        if (!this._backup) {
            const { BackupManager } = require('./backup');
            this._backup = new BackupManager(this.dataDir, {});
        }
        return this._backup.list(project);
    }

    /**
     * Backup status for a project.
     * @param {string} project
     * @returns {object}
     */
    backupStatus(project) {
        if (!this._backup) {
            const { BackupManager } = require('./backup');
            this._backup = new BackupManager(this.dataDir, {});
        }
        return this._backup.status(project);
    }

    /**
     * Auto-backup all known projects.
     * Scans snapshot directory for project folders and backs up each.
     */
    async _runAutoBackup() {
        if (!this._backup) return;
        const snapBaseDir = path.join(this.dataDir, 'kv-cache', 'snapshots');

        try {
            if (!fs.existsSync(snapBaseDir)) return;
            const projects = fs.readdirSync(snapBaseDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('_'))
                .map(d => d.name);

            for (const project of projects) {
                try {
                    const result = await this._backup.backup(project, {});
                    if (result.type !== 'skip' && result.type !== 'empty') {
                        console.error(`[kv-cache] Auto-backup: ${project} → ${result.sizeFormatted} (${result.type})`);
                    }
                } catch (e) { logError('kv-cache:auto-backup', `${project}: ${e.message}`); }
            }
        } catch (err) {
            console.error(`[kv-cache] Auto-backup error: ${err.message}`);
        }
    }

    /**
     * Stop auto-backup scheduler and cleanup.
     */
    stopAutoBackup() {
        if (this._backupTimer) {
            clearTimeout(this._backupTimer);
            clearInterval(this._backupTimer);
            this._backupTimer = null;
        }
    }
}

module.exports = { SoulKVCache };
