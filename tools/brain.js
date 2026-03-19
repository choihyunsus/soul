// Soul MCP v6.0 — Brain tools. Shared memory + Entity Memory + Core Memory.
const path = require('path');
const { readFile, writeFile, safePath } = require('../lib/utils');
const { EntityMemory } = require('../lib/entity-memory');
const { CoreMemory } = require('../lib/core-memory');

function registerBrainTools(server, z, config) {
    const memoryDir = path.join(config.DATA_DIR, 'memory');
    const entityMemory = new EntityMemory(config.DATA_DIR);
    const coreMemory = new CoreMemory(config.DATA_DIR);

    // ── Brain Read/Write ──

    server.registerTool(
        'n2_brain_read',
        {
            title: 'N2 Brain Read',
            description: 'Read a file from shared memory (data/memory/). Agents share information here.',
            inputSchema: {
                filename: z.string().describe('File path relative to memory directory'),
            },
        },
        async ({ filename }) => {
            const filePath = safePath(filename, memoryDir);
            if (!filePath) return { content: [{ type: 'text', text: `BLOCKED: Path traversal denied — "${filename}"` }] };
            const content = readFile(filePath);
            if (!content) return { content: [{ type: 'text', text: `NOT FOUND: ${filePath}` }] };
            return { content: [{ type: 'text', text: content }] };
        }
    );

    server.registerTool(
        'n2_brain_write',
        {
            title: 'N2 Brain Write',
            description: 'Write a file to shared memory (data/memory/). Share information between agents.',
            inputSchema: {
                filename: z.string().describe('File path relative to memory directory'),
                content: z.string().describe('File content'),
            },
        },
        async ({ filename, content }) => {
            const filePath = safePath(filename, memoryDir);
            if (!filePath) return { content: [{ type: 'text', text: `BLOCKED: Path traversal denied — "${filename}"` }] };
            writeFile(filePath, content);
            return { content: [{ type: 'text', text: `Saved: memory/${filename} (${content.length} chars)` }] };
        }
    );

    // ── Entity Memory ──

    server.registerTool(
        'n2_entity_upsert',
        {
            title: 'N2 Entity Upsert',
            description: 'Add or update entities (person, hardware, project, concept). Auto-merges attributes if entity exists.',
            inputSchema: {
                entities: z.array(z.object({
                    type: z.string().describe('Entity type: person, hardware, project, concept, place, service'),
                    name: z.string().describe('Entity name'),
                    attributes: z.record(z.any()).optional().describe('Key-value attributes'),
                })).describe('Entities to upsert'),
            },
        },
        async ({ entities }) => {
            const result = entityMemory.upsertBatch(entities);
            return { content: [{ type: 'text', text: `Entity upsert: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped` }] };
        }
    );

    server.registerTool(
        'n2_entity_search',
        {
            title: 'N2 Entity Search',
            description: 'Search entities by keyword or type. Returns matching entities with attributes.',
            inputSchema: {
                query: z.string().optional().describe('Search keyword'),
                type: z.string().optional().describe('Filter by type: person, hardware, project, concept, place, service'),
            },
        },
        async ({ query, type }) => {
            let results;
            if (type) {
                results = entityMemory.getByType(type);
            } else if (query) {
                results = entityMemory.search(query);
            } else {
                results = entityMemory.list();
            }
            if (results.length === 0) {
                return { content: [{ type: 'text', text: 'No entities found.' }] };
            }
            const text = results.map(e =>
                `[${e.type}] ${e.name} (mentions: ${e.mentionCount || 0}) — ${JSON.stringify(e.attributes || {})}`
            ).join('\n');
            return { content: [{ type: 'text', text: `Entities (${results.length}):\n${text}` }] };
        }
    );

    // ── Core Memory ──

    server.registerTool(
        'n2_core_read',
        {
            title: 'N2 Core Read',
            description: 'Read agent-specific core memory. Core memory is always loaded at boot for context injection.',
            inputSchema: {
                agent: z.string().describe('Agent name'),
            },
        },
        async ({ agent }) => {
            const data = coreMemory.read(agent);
            const entries = Object.entries(data.memory || {});
            if (entries.length === 0) {
                return { content: [{ type: 'text', text: `Core memory for ${agent}: (empty)` }] };
            }
            const text = entries.map(([k, v]) => `  ${k}: ${v}`).join('\n');
            return { content: [{ type: 'text', text: `Core memory for ${agent}:\n${text}` }] };
        }
    );

    server.registerTool(
        'n2_core_write',
        {
            title: 'N2 Core Write',
            description: 'Write to agent-specific core memory. Stored permanently, injected at every boot.',
            inputSchema: {
                agent: z.string().describe('Agent name'),
                key: z.string().describe('Memory key (e.g. "current_focus", "working_rules")'),
                value: z.string().describe('Memory value'),
            },
        },
        async ({ agent, key, value }) => {
            const result = coreMemory.write(agent, key, value);
            return { content: [{ type: 'text', text: `Core memory ${result.action}: ${agent}.${key}` }] };
        }
    );
}

module.exports = { registerBrainTools };
