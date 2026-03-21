// n2-arachne — Code Context Assembly (Soul embedded). The Greatest Weaver.
const path = require('path');
const { Store } = require('./store');
const { Indexer } = require('./indexer');
const { BM25Search } = require('./search');
const { Backup } = require('./backup');
const { Assembler } = require('./assembler');

/**
 * Creates an Arachne instance for Soul integration.
 * Follows the same factory pattern as Ark (createArk).
 *
 * @param {object} options
 * @param {string} options.dataDir — SQLite data directory
 * @param {string} options.projectDir — Project root to index
 * @param {object} options.indexing — Indexing settings
 * @param {object} options.search — Search settings
 * @param {object} options.assembly — Assembly settings
 * @param {object} options.backup — Backup settings
 * @param {object} options.embedding — Embedding settings (optional)
 * @returns {Promise<object>} Arachne instance
 */
async function createArachne(options = {}) {
    const dataDir = options.dataDir || path.join(__dirname, '..', '..', 'data', 'arachne');
    const projectDir = options.projectDir || process.cwd();

    // Initialize Store
    const store = new Store(dataDir);
    await store.init();
    console.error(`[n2-arachne] DB initialized: ${store.dbPath}`);

    // Initialize engines
    const indexer = new Indexer(store, options);
    const search = new BM25Search(store, options.search || {});
    const backup = new Backup(store, options.backup || {});
    const assembler = new Assembler(store, search, options.assembly || {});

    // Optional: Semantic search
    let vectorStore = null;
    if (options.embedding?.enabled) {
        try {
            const { Embedding } = require('./embedding');
            const { VectorStore } = require('./vector-store');
            const embedding = new Embedding(options.embedding);
            vectorStore = new VectorStore(store, embedding);
            const initialized = await vectorStore.init();
            if (initialized) {
                search.setVectorStore(vectorStore);
                assembler.setVectorStore(vectorStore);
                console.error(`[n2-arachne] Semantic search enabled (${embedding.model})`);
            }
        } catch (err) {
            console.error(`[n2-arachne] Semantic search unavailable: ${err.message}`);
        }
    }

    // Auto-indexing
    if (options.indexing?.autoIndex !== false) {
        try {
            const result = await indexer.index(projectDir);
            console.error(`[n2-arachne] Indexed: ${result.indexed} files (${result.skipped} unchanged) in ${result.elapsed}ms`);

            if (vectorStore?.isReady) {
                const embedResult = await vectorStore.embedNewChunks();
                console.error(`[n2-arachne] Embedded: ${embedResult.embedded} chunks`);
            }
        } catch (err) {
            console.error(`[n2-arachne] Auto-index failed: ${err.message}`);
        }
    }

    return {
        store,
        indexer,
        search,
        backup,
        assembler,
        vectorStore,
        projectDir,

        /** Search code by query */
        searchCode(query, opts = {}) {
            return search.search(query, opts);
        },

        /** Assemble context for AI */
        async assemble(query, opts = {}) {
            return assembler.assemble(query, {
                projectDir,
                ...opts,
            });
        },

        /** Re-index project */
        async reindex(opts = {}) {
            return indexer.index(projectDir, opts);
        },

        /** Get indexing stats */
        stats() {
            return indexer.getStats();
        },

        /** Create backup */
        async createBackup(label) {
            return backup.create(label);
        },

        /** Shutdown */
        close() {
            store.close();
        },
    };
}

module.exports = { createArachne };
