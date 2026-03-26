// Soul MCP v9.0 — Brain tools. Shared memory + Entity Memory + Core Memory.
import path from 'path';
import type { z as ZodType } from 'zod';
import { readFile, writeFile, safePath } from '../lib/utils';
import { EntityMemory } from '../lib/entity-memory';
import type { EntityInput } from '../lib/entity-memory';
import { CoreMemory } from '../lib/core-memory';
import type { McpToolServer, SoulConfig, EntityType } from '../types';

export function registerBrainTools(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
): void {
  const memoryDir = path.join(config.DATA_DIR, 'memory');
  const entityMemory = new EntityMemory(config.DATA_DIR);
  const coreMemory = new CoreMemory(config.DATA_DIR);

  // ── Brain Read ──
  server.tool(
    'n2_brain_read',
    'Read a file from shared memory (data/memory/). Agents share information here.',
    {
      filename: z.string().describe('File path relative to memory directory'),
    },
    async ({ filename }: { filename: string }) => {
      const filePath = safePath(filename, memoryDir);
      if (!filePath) return { content: [{ type: 'text', text: `BLOCKED: Path traversal denied — "${filename}"` }] };
      const content = readFile(filePath);
      if (!content) return { content: [{ type: 'text', text: `NOT FOUND: ${filePath}` }] };
      return { content: [{ type: 'text', text: content }] };
    },
  );

  // ── Brain Write ──
  server.tool(
    'n2_brain_write',
    'Write a file to shared memory (data/memory/). Share information between agents.',
    {
      filename: z.string().describe('File path relative to memory directory'),
      content: z.string().describe('File content'),
    },
    async ({ filename, content }: { filename: string; content: string }) => {
      const filePath = safePath(filename, memoryDir);
      if (!filePath) return { content: [{ type: 'text', text: `BLOCKED: Path traversal denied — "${filename}"` }] };
      writeFile(filePath, content);
      return { content: [{ type: 'text', text: `Saved: memory/${filename} (${content.length} chars)` }] };
    },
  );

  // ── Entity Upsert ──
  server.tool(
    'n2_entity_upsert',
    'Add or update entities (person, hardware, project, concept). Auto-merges attributes if entity exists.',
    {
      entities: z.array(z.object({
        type: z.string().describe('Entity type: person, hardware, project, concept, place, service'),
        name: z.string().describe('Entity name'),
        attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Key-value attributes'),
      })).describe('Entities to upsert'),
    },
    async ({ entities }: { entities: EntityInput[] }) => {
      const result = entityMemory.upsertBatch(entities);
      return { content: [{ type: 'text', text: `Entity upsert: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped` }] };
    },
  );

  // ── Entity Search ──
  server.tool(
    'n2_entity_search',
    'Search entities by keyword or type. Returns matching entities with attributes.',
    {
      query: z.string().optional().describe('Search keyword'),
      type: z.string().optional().describe('Filter by type: person, hardware, project, concept, place, service'),
    },
    async ({ query, type }: { query?: string; type?: string }) => {
      let results: ReturnType<EntityMemory['list']>;
      if (type) {
        results = entityMemory.getByType(type as EntityType);
      } else if (query) {
        results = entityMemory.search(query);
      } else {
        results = entityMemory.list();
      }
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No entities found.' }] };
      }
      const text = results.map(e =>
        `[${e.type}] ${e.name} (mentions: ${e.mentionCount ?? 0}) — ${JSON.stringify(e.attributes ?? {})}`,
      ).join('\n');
      return { content: [{ type: 'text', text: `Entities (${results.length}):\n${text}` }] };
    },
  );

  // ── Core Read ──
  server.tool(
    'n2_core_read',
    'Read agent-specific core memory. Core memory is always loaded at boot for context injection.',
    {
      agent: z.string().describe('Agent name'),
    },
    async ({ agent }: { agent: string }) => {
      const data = coreMemory.read(agent);
      const entries = Object.entries(data.memory ?? {});
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: `Core memory for ${agent}: (empty)` }] };
      }
      const text = entries.map(([k, v]) => `  ${k}: ${v}`).join('\n');
      return { content: [{ type: 'text', text: `Core memory for ${agent}:\n${text}` }] };
    },
  );

  // ── Core Write ──
  server.tool(
    'n2_core_write',
    'Write to agent-specific core memory. Stored permanently, injected at every boot.',
    {
      agent: z.string().describe('Agent name'),
      key: z.string().describe('Memory key (e.g. "current_focus", "working_rules")'),
      value: z.string().describe('Memory value'),
    },
    async ({ agent, key, value }: { agent: string; key: string; value: string }) => {
      const result = coreMemory.write(agent, key, value);
      return { content: [{ type: 'text', text: `Core memory ${result.action}: ${agent}.${key}` }] };
    },
  );
}
