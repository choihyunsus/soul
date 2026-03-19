// Soul MCP v6.0 — Dynamic agent registry. Detects agents from N2 Browser config.
const fs = require('fs');
const path = require('path');
const { logError, readJson } = require('./utils');

// Detect agents directory dynamically (project-local first, cross-platform)
function detectAgentsDir() {
    const { getAgentsDir } = require('./paths');
    const candidates = [
        process.env.N2_AGENTS_DIR,
        getAgentsDir(),
        path.join(process.cwd(), '_data', 'agents'),
    ].filter(Boolean);

    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

// List all registered agents from the agents directory
function listAgents(agentsDir) {
    if (!agentsDir || !fs.existsSync(agentsDir)) return [];
    try {
        return fs.readdirSync(agentsDir)
            .filter(f => f.endsWith('.json') && f !== 'global.json')
            .map(f => {
                const data = readJson(path.join(agentsDir, f));
                if (!data) return null;
                return {
                    id: data.id || path.basename(f, '.json'),
                    name: data.name || 'unknown',
                    provider: data.provider || 'unknown',
                    model: data.model || 'unknown',
                    soul: data.soul || '',
                    rank: data.rank || '?',
                    enabled: data.enabled !== false,
                };
            })
            .filter(Boolean)
            .filter(a => a.enabled);
    } catch (e) {
        logError('listAgents', e);
        return [];
    }
}

// Find agent by name (case-insensitive)
function findAgent(agentsDir, name) {
    const agents = listAgents(agentsDir);
    return agents.find(a => a.name.toLowerCase() === name.toLowerCase()) || null;
}

// Read global config
function readGlobalConfig(agentsDir) {
    if (!agentsDir) return null;
    return readJson(path.join(agentsDir, 'global.json'));
}

module.exports = { detectAgentsDir, listAgents, findAgent, readGlobalConfig };
