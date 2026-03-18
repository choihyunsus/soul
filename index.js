// Soul MCP v5.0 — Entry point. Multi-agent session orchestrator with KV-Cache.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const config = require('./lib/config');

// Sequences — agent lifecycle management
const { registerBootSequence } = require('./sequences/boot');
const { registerWorkSequence } = require('./sequences/work');
const { registerEndSequence } = require('./sequences/end');

// Tools — shared memory + KV-Cache persistence
const { registerBrainTools } = require('./tools/brain');
const { registerKVCacheTools } = require('./tools/kv-cache');

const server = new McpServer({
    name: 'n2-soul',
    version: '5.0.1',
});

// Register all modules
registerBootSequence(server, z, config);
registerWorkSequence(server, z, config);
registerEndSequence(server, z, config);
registerBrainTools(server, z, config);
registerKVCacheTools(server, z, config);

// Start
const transport = new StdioServerTransport();
server.connect(transport);
