// Soul MCP v9.0 - Entry point. Multi-agent session orchestrator with KV-Cache.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import config from './lib/config';
import { SoulEngine } from './lib/soul-engine';
import { registerBootSequence } from './sequences/boot';
import { registerWorkSequence, disposeWorkSequence } from './sequences/work';
import { registerEndSequence } from './sequences/end';
import { registerBrainTools } from './tools/brain';
import { registerLearningTools } from './tools/mimir-learning';
import { registerKVCacheTools } from './tools/kv-cache';
import type { McpToolServer } from './types';
import pkg from '../package.json';

const server = new McpServer({ name: 'n2-soul', version: pkg.version }) as McpToolServer;
const engine = new SoulEngine(config.DATA_DIR);

// Register core modules (shared SoulEngine instance)
registerBootSequence(server, z, config, engine);
registerWorkSequence(server, z, config, engine);
registerEndSequence(server, z, config, engine);
registerBrainTools(server, z, config);
registerKVCacheTools(server, z, config);
registerLearningTools(server, z, config);

// Start MCP transport
async function boot(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

boot().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[n2-soul] Fatal: ${message}`);
  process.exit(1);
});

// L1: Graceful shutdown - synchronously clean up timers before exit
function shutdown(): void {
  disposeWorkSequence();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
