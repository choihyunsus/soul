// Soul v9.0 — Central path manager. Cross-platform compatible.
import path from 'path';
import fs from 'fs';

// soul/src/lib/paths.ts → 3 levels up = project root (src/lib/paths.ts → soul/)
export const SOUL_ROOT: string = path.resolve(__dirname, '..', '..');
export const PROJECT_ROOT: string = path.resolve(SOUL_ROOT, '..');

// Local fallback only — always use config.DATA_DIR when available
const DATA_ROOT: string = path.join(SOUL_ROOT, 'data');

/** Agents directory path (auto-created if needed) */
export function getAgentsDir(): string {
  let dataDir: string;
  try {
    // NOTE: require() kept to avoid circular dependency — config imports paths indirectly
    const config = require('./config') as { DATA_DIR?: string };
    dataDir = config.DATA_DIR || DATA_ROOT;
  } catch {
    dataDir = DATA_ROOT;
  }
  const dir = path.join(dataDir, 'agents');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { DATA_ROOT };
