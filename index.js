// Soul MCP v6.0 — Entry point. Multi-agent session orchestrator with KV-Cache + Ark.
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const config = require('./lib/config');
const { createArk } = require('./lib/ark');

// Sequences — agent lifecycle management
const { registerBootSequence } = require('./sequences/boot');
const { registerWorkSequence } = require('./sequences/work');
const { registerEndSequence } = require('./sequences/end');

// Tools — shared memory + KV-Cache persistence
const { registerBrainTools } = require('./tools/brain');
const { registerKVCacheTools } = require('./tools/kv-cache');

const server = new McpServer({
    name: 'n2-soul',
    version: '6.0.2',
});

// ═══════════════════════════════════════════════════════
// Ark — THE LAST SHIELD
// "You shall not pass."
//
// Pure & simple: every tool call → check against rules.
// No tool classification. No special cases.
// The RULES decide what's blocked — not the code.
// ═══════════════════════════════════════════════════════
const ark = createArk({
    rulesDir: config.ARK?.rulesDir || path.join(__dirname, 'rules'),
    auditDir: config.ARK?.auditDir || path.join(config.DATA_DIR, 'ark-audit'),
    strictMode: config.ARK?.strictMode || false,
    auditEnabled: true,
});

const _origRegisterTool = server.registerTool.bind(server);
server.registerTool = (name, schema, handler) => {
    _origRegisterTool(name, schema, async (args) => {
        const content = JSON.stringify(args);
        const result = ark.check(name, content, 'tool_call');
        if (!result.allowed) {
            return {
                content: [{
                    type: 'text',
                    text: `[n2-ark] BLOCKED: ${result.reason}\n` +
                          `Rule: ${result.rule} | Action: ${result.action}\n` +
                          `This action requires human approval.`,
                }],
            };
        }
        return handler(args);
    });
};
// ═══ End Ark ═══

// Register all modules (all tools now pass through Ark)
registerBootSequence(server, z, config);
registerWorkSequence(server, z, config);
registerEndSequence(server, z, config);
registerBrainTools(server, z, config);
registerKVCacheTools(server, z, config);

// Start
const transport = new StdioServerTransport();
server.connect(transport);
