// Soul MCP v6.0 — Central path manager. Cross-platform compatible.
// NOTE: DATA_ROOT here is a fallback for agent-registry only.
// For Cloud Storage, use config.DATA_DIR (set in config.local.js).
const path = require('path');
const fs = require('fs');

// soul/lib/paths.js → 2 levels up = project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = path.join(path.resolve(__dirname, '..'), 'data');

/** Agents directory path (auto-created if needed) */
function getAgentsDir() {
    const dir = path.join(DATA_ROOT, 'agents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = {
    PROJECT_ROOT,
    DATA_ROOT,
    getAgentsDir,
};
