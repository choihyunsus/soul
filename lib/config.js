// Soul MCP v6.0 — Config loader. Deep-merges config.default.js with config.local.js overrides.
const defaults = require('./config.default.js');

let local = {};
try {
    local = require('./config.local.js');
} catch (e) {
    // config.local.js is optional — only silence MODULE_NOT_FOUND
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
}

// Deep merge: local overrides default, nested objects are merged (not replaced)
function deepMerge(base, override) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
        if (
            override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
            base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
        ) {
            result[key] = deepMerge(base[key], override[key]);
        } else {
            result[key] = override[key];
        }
    }
    return result;
}

module.exports = deepMerge(defaults, local);
