// Soul v9.0 — Config loader. Deep-merges config.default with config.local overrides.
import type { SoulConfig } from '../types';
import defaults from './config.default';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

let local: DeepPartial<SoulConfig> = {};
try {
  // NOTE: require() intentionally kept — config.local.js is a runtime-optional CJS file
  // that may or may not exist. Static import cannot handle optional modules gracefully.
  local = require('./config.local.js');
} catch (e: unknown) {
  const err = e as NodeJS.ErrnoException;
  if (err.code !== 'MODULE_NOT_FOUND') throw e;
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

const config: SoulConfig = deepMerge(
  defaults as unknown as Record<string, unknown>,
  local as unknown as DeepPartial<Record<string, unknown>>,
) as unknown as SoulConfig;

export default config;
