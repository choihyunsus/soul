// Soul v9.0 - Config loader. Deep-merges config.default with config.local overrides.
import type { SoulConfig } from '../types';
import defaults from './config.default';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

let local: DeepPartial<SoulConfig> = {};
try {
  // NOTE: require() intentionally kept - config.local.js is a runtime-optional CJS file
  // that may or may not exist. Static import cannot handle optional modules gracefully.
  const rawConf: unknown = require('./config.local.js');
  local = (typeof rawConf === 'object' && rawConf !== null ? rawConf : {}) as DeepPartial<SoulConfig>;
} catch (e: unknown) {
  if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw e;
}

/** Deep merge: local overrides default, nested objects are merged (not replaced) */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: DeepPartial<T>,
): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const ov = override[key as keyof typeof override];
    const bv = base[key as keyof T];
    if (
      ov && typeof ov === 'object' && !Array.isArray(ov) &&
      bv && typeof bv === 'object' && !Array.isArray(bv)
    ) {
      result[key] = deepMerge(
        bv as Record<string, unknown>,
        ov as DeepPartial<Record<string, unknown>>,
      );
    } else {
      result[key] = ov;
    }
  }
  return result as T;
}

type IndexedConfig = SoulConfig & Record<string, unknown>;

const config: SoulConfig = deepMerge(
  defaults as IndexedConfig,
  local as DeepPartial<IndexedConfig>,
);

// M3: Basic config validation - catch malformed config.local.js early
if (!config.DATA_DIR || typeof config.DATA_DIR !== 'string') {
  throw new Error('[soul:config] FATAL: DATA_DIR is missing or invalid. Check config.default.ts or config.local.js');
}
if (config.KV_CACHE?.enabled && config.KV_CACHE?.maxSnapshotsPerProject !== undefined) {
  if (typeof config.KV_CACHE.maxSnapshotsPerProject !== 'number' || config.KV_CACHE.maxSnapshotsPerProject < 1) {
    console.error('[soul:config] WARNING: KV_CACHE.maxSnapshotsPerProject must be a positive number, using default');
    config.KV_CACHE.maxSnapshotsPerProject = 50;
  }
}

export default config;
