// indexer.js — Project file scanner with incremental indexing
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IgnoreFilter } = require('./ignore');
const { chunkCode, detectLanguage, setTokenMultiplier } = require('./chunker');
const { indexFileDependencies } = require('./dependency');

class Indexer {
    /**
     * @param {import('./store').Store} store
     * @param {object} config - Full configuration object
     */
    constructor(store, config) {
        this._store = store;
        this._config = config;
        this._ignoreFilter = null;

        // Apply token multiplier from config
        if (config.indexing?.tokenMultiplier) {
            setTokenMultiplier(config.indexing.tokenMultiplier);
        }
    }

    /**
     * Index project (incremental — only changed files)
     * @param {string} projectDir - Project root path
     * @param {object} [options]
     * @param {boolean} [options.force] - If true, force full re-indexing
     * @param {string} [options.subPath] - Only index this sub-path
     * @returns {Promise<{indexed:number, skipped:number, removed:number, elapsed:number}>}
     */
    async index(projectDir, options = {}) {
        const startTime = Date.now();
        const scanDir = options.subPath
            ? path.resolve(projectDir, options.subPath)
            : projectDir;

        // Initialize ignore filter
        this._ignoreFilter = new IgnoreFilter(this._config.ignore, projectDir);

        // 1. Scan file list
        const files = this._scanFiles(scanDir, projectDir);

        // Max file count check
        const maxFiles = this._config.indexing.maxFiles || 50000;
        if (files.length > maxFiles) {
            console.error(`[n2-context] Warning: ${files.length} files found, limiting to ${maxFiles}`);
            files.length = maxFiles;
        }

        // 2. Clear existing data for full re-indexing
        if (options.force) {
            this._store.db.exec('DELETE FROM chunks');
            this._store.db.exec('DELETE FROM files');
        }

        // 3. Incremental indexing
        let indexed = 0;
        let skipped = 0;

        for (const fileMeta of files) {
            const result = this._indexFile(fileMeta, projectDir);
            if (result === 'indexed') indexed++;
            else skipped++;
        }

        // 4. Clean stale files
        const removed = this._store.cleanStaleFiles(projectDir);

        // 5. Update metadata
        this._store._setMeta('last_indexed_at', new Date().toISOString());
        this._store._setMeta('project_dir', projectDir);
        this._store._setMeta('file_count', String(indexed + skipped));

        const elapsed = Date.now() - startTime;
        return { indexed, skipped, removed, elapsed, total: files.length };
    }

    /**
     * Recursive directory scan
     * @returns {Array<{absolutePath:string, relativePath:string, stat:fs.Stats}>}
     */
    _scanFiles(dir, projectRoot) {
        const results = [];
        const maxFileSize = this._config.indexing.maxFileSize || 1024 * 1024;
        const supported = new Set([
            ...(this._config.indexing.supportedLanguages || []),
            ...(this._config.indexing.alsoIndexAsText || []),
        ]);

        const scan = (currentDir) => {
            let entries;
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                return; // Skip directories without read permission
            }

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                const relativePath = path.relative(projectRoot, fullPath);

                // Check ignore filter
                if (this._ignoreFilter.isIgnored(relativePath)) continue;

                if (entry.isDirectory()) {
                    // Also check directory itself against ignore filter
                    if (this._ignoreFilter.isIgnored(relativePath + '/')) continue;
                    scan(fullPath);
                } else if (entry.isFile()) {
                    // Extension check
                    const ext = path.extname(entry.name).slice(1).toLowerCase();
                    if (!supported.has(ext)) continue;

                    // File size check
                    let stat;
                    try { stat = fs.statSync(fullPath); } catch { continue; }
                    if (stat.size > maxFileSize) continue;
                    if (stat.size === 0) continue;

                    results.push({
                        absolutePath: fullPath,
                        relativePath: relativePath.replace(/\\/g, '/'),
                        stat,
                    });
                }
            }
        };

        scan(dir);
        return results;
    }

    /**
     * Index individual file
     * @returns {'indexed'|'skipped'}
     */
    _indexFile(fileMeta, projectDir) {
        const { absolutePath, relativePath, stat } = fileMeta;

        // Read file content + compute hash
        let content;
        try {
            content = fs.readFileSync(absolutePath, 'utf-8');
        } catch {
            return 'skipped';
        }

        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        const ext = path.extname(absolutePath).slice(1).toLowerCase();
        const modifiedAt = stat.mtime.toISOString();

        // DB upsert (hash comparison determines change)
        const { action, fileId } = this._store.upsertFile(
            relativePath, hash, ext, stat.size, modifiedAt
        );

        if (action === 'skipped') return 'skipped';

        // Chunking
        const chunks = chunkCode(content, ext);

        // Save chunks to DB
        if (chunks.length > 0) {
            this._store.insertChunks(fileId, chunks);
        }

        // Phase 2: Extract dependencies
        try {
            indexFileDependencies(this._store, fileId, content, ext, relativePath);
        } catch {
            // Dependency extraction failure is non-fatal
        }

        return 'indexed';
    }

    /**
     * Get indexed file list
     */
    getFiles(options = {}) {
        return this._store.getAllFiles(options.language);
    }

    /**
     * Get index statistics
     */
    getStats() {
        return this._store.getStats();
    }
}

module.exports = { Indexer };
