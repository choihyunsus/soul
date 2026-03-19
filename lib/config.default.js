// Soul MCP v6.0 — Default config. Zero hardcoded paths, all dynamic.
const path = require('path');

module.exports = {
    // All paths derived dynamically. No hardcoding.
    SOUL_ROOT: path.resolve(__dirname, '..'),
    DATA_DIR: path.resolve(__dirname, '..', 'data'),
    TIMEZONE: 'Asia/Seoul',  // Override with config.local.js for other timezones
    AGENTS_DIR: null, // Auto-detected by agent-registry.js

    // Language (for time formatting)
    LANG: process.env.N2_LANG || 'en',

    // Context search settings (n2_context_search)
    SEARCH: {
        maxDepth: 6,
        minKeywordLength: 2,
        previewLength: 200,
        recencyBonus: 10,
        defaultMaxResults: 10,
        semanticEnabled: false,    // Enable hybrid semantic search (requires Ollama)
        semanticWeight: 0.3,       // Weight for semantic vs keyword (0-1, 0=keyword only)
    },

    // File tree rendering settings (boot/work_end output)
    FILE_TREE: {
        hidePaths: [
            'test', '_data', '_history',
            'soul/data/kv-cache',
        ],
        compactPaths: [
            'soul/data/projects',
            'soul/data/memory',
        ],
        childLimit: 20,
    },

    // KV-Cache settings
    KV_CACHE: {
        enabled: true,
        autoSaveOnWorkEnd: true,
        autoLoadOnBoot: true,
        backend: 'json',                // 'json' (default) or 'sqlite'
        maxSnapshotsPerProject: 50,
        maxSnapshotAgeDays: 30,
        compressionTarget: 1000,
        snapshotDir: null,              // null = auto (DATA_DIR/kv-cache/snapshots)
        sqliteDir: null,                // null = auto (DATA_DIR/kv-cache/sqlite)
        tokenBudget: {
            bootContext: 2000,
            searchResult: 500,
            progressiveLoad: true,
        },
        tier: {
            hotDays: 7,                 // Hot: in-memory cache (days)
            warmDays: 30,               // Warm: file/db access (days)
        },
        embedding: {
            enabled: false,             // Requires Ollama with nomic-embed-text
            model: 'nomic-embed-text',
            endpoint: null,             // null = http://127.0.0.1:11434
        },
        backup: {
            enabled: false,
            dir: null,                  // null = DATA_DIR/kv-cache/backups
            schedule: 'daily',          // 'manual', 'daily', 'weekly'
            keepCount: 7,
            incremental: true,
        },
    },

    // Ark — THE LAST SHIELD. NO enabled toggle (by design).
    // Ark is ALWAYS loaded. "You shall not pass."
    ARK: {
        rulesDir: null,     // null = soul/rules/
        auditDir: null,     // null = soul/data/ark-audit/
        strictMode: false,  // true = block unknown actions too
    },
};
