// Soul MCP v7.0 — Entry point. Multi-agent session orchestrator with KV-Cache + Ark + Arachne.
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const config = require('./lib/config');
const { createArk } = require('./lib/ark');
const { createArachne } = require('./lib/arachne');

// Sequences — agent lifecycle management
const { registerBootSequence } = require('./sequences/boot');
const { registerWorkSequence } = require('./sequences/work');
const { registerEndSequence } = require('./sequences/end');

// Tools — shared memory + KV-Cache persistence + code context
const { registerBrainTools } = require('./tools/brain');
const { registerKVCacheTools } = require('./tools/kv-cache');
const { registerArachneTools } = require('./tools/arachne');

const pkg = require('./package.json');
const server = new McpServer({
    name: 'n2-soul',
    version: pkg.version,
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
    rulesDir: config.ARK?.rulesDir ?? path.join(__dirname, 'rules'),
    auditDir: config.ARK?.auditDir ?? path.join(config.DATA_DIR, 'ark-audit'),
    strictMode: config.ARK?.strictMode ?? false,
    auditMaxAgeDays: config.ARK?.auditMaxAgeDays ?? 7,
    auditEnabled: true,
});

// Ark-wrapped registerTool shim — bridges legacy registerTool() to SDK v1.6.1 server.tool()
const _origTool = server.tool.bind(server);
const _arkWrap = (name, handler) => async (args) => {
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
};
// Shim: server.registerTool(name, {title, description, inputSchema}, handler) → server.tool()
server.registerTool = (name, schema, handler) => {
    const desc = schema.description || schema.title || name;
    _origTool(name, desc, schema.inputSchema || {}, _arkWrap(name, handler));
};
// Override: server.tool() with Ark check (for files using new API directly, e.g. arachne.js)
server.tool = (name, ...rest) => {
    const handler = rest.pop();
    _origTool(name, ...rest, _arkWrap(name, handler));
};
// ═══ End Ark ═══

// Register core modules (all tools pass through Ark)
registerBootSequence(server, z, config, ark);
registerWorkSequence(server, z, config);
registerEndSequence(server, z, config);
registerBrainTools(server, z, config);
registerKVCacheTools(server, z, config);

// ═══════════════════════════════════════════════════════
// Arachne — THE GREATEST WEAVER
// Code context assembly engine — indexes codebase,
// picks exactly what AI needs.
// Only activates when ARACHNE config is present.
// ═══════════════════════════════════════════════════════
async function boot() {
    // Initialize Arachne (if configured)
    if (config.ARACHNE?.projectDir) {
        try {
            const arachne = await createArachne({
                ...config.ARACHNE,
                dataDir: config.ARACHNE.dataDir ?? path.join(config.DATA_DIR, 'arachne'),
            });
            registerArachneTools(server, z, arachne, config);
            console.error(`[n2-soul] Arachne enabled: ${config.ARACHNE.projectDir}`);
        } catch (err) {
            console.error(`[n2-soul] Arachne init failed: ${err.message}`);
        }
    }

    // Start MCP transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

boot().catch(err => {
    console.error(`[n2-soul] Fatal: ${err.message}`);
    process.exit(1);
});
