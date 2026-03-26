// Soul v9.0 — Default config. Zero hardcoded paths, all dynamic.
import path from 'path';
import type { SoulConfig } from '../types';

const defaults: SoulConfig = {
  SOUL_ROOT: path.resolve(__dirname, '..', '..'),
  DATA_DIR: path.resolve(__dirname, '..', '..', 'data'),
  TIMEZONE: 'Asia/Seoul',
  AGENTS_DIR: null,
  LANG: process.env.N2_LANG || 'en',

  SEARCH: {
    maxDepth: 6,
    minKeywordLength: 2,
    previewLength: 200,
    recencyBonus: 10,
    defaultMaxResults: 10,
    semanticEnabled: false,
    semanticWeight: 0.3,
  },

  FILE_TREE: {
    hidePaths: ['test', '_data', '_history', 'soul/data/kv-cache'],
    compactPaths: ['soul/data/projects', 'soul/data/memory'],
    childLimit: 20,
  },

  WORK: {
    sessionTtlHours: 24,
    maxDecisions: 20,
  },

  KV_CACHE: {
    enabled: true,
    autoSaveOnWorkEnd: true,
    autoLoadOnBoot: true,
    backend: 'json',
    maxSnapshotsPerProject: 50,
    maxSnapshotAgeDays: 30,
    compressionTarget: 1000,
    snapshotDir: null,
    sqliteDir: null,
    tokenBudget: {
      bootContext: 2000,
      searchResult: 500,
      progressiveLoad: true,
    },
    tier: {
      hotDays: 7,
      warmDays: 30,
    },
    embedding: {
      enabled: false,
      model: 'nomic-embed-text',
      endpoint: null,
    },
    backup: {
      enabled: false,
      dir: null,
      schedule: 'daily',
      keepCount: 7,
      incremental: true,
    },
  },
};

export default defaults;
