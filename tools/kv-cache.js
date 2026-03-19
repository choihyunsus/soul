// Soul KV-Cache — MCP tool registration. Exposes KV-Cache to agents.
const { SoulKVCache } = require('../lib/kv-cache');

/**
 * Registers KV-Cache MCP tools.
 * @param {object} server - MCP server
 * @param {object} z - Zod validator
 * @param {object} config - Soul config
 */
function registerKVCacheTools(server, z, config) {
    if (!config.KV_CACHE?.enabled) return;

    const kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);

    // n2_kv_save — Save session snapshot
    server.registerTool(
        'n2_kv_save',
        {
            title: 'N2 KV Save',
            description: 'Save current session as a KV-Cache snapshot. Auto-called at n2_work_end if enabled.',
            inputSchema: {
                agent: z.string().describe('Agent name'),
                project: z.string().describe('Project name'),
                summary: z.string().describe('Session summary'),
                decisions: z.array(z.string()).optional().describe('Key decisions made'),
                todo: z.array(z.string()).optional().describe('TODO items for next session'),
                filesCreated: z.array(z.object({
                    path: z.string(), desc: z.string(),
                })).optional().describe('Files created'),
                filesModified: z.array(z.object({
                    path: z.string(), desc: z.string(),
                })).optional().describe('Files modified'),
            },
        },
        async ({ agent, project, summary, decisions, todo, filesCreated, filesModified }) => {
            try {
                const id = kvCache.save(agent, project, {
                    summary,
                    decisions: decisions || [],
                    todo: todo || [],
                    filesCreated: filesCreated || [],
                    filesModified: filesModified || [],
                });
                const snapCount = kvCache.listSnapshots(project).length;
                return {
                    content: [{
                        type: 'text',
                        text: `KV-Cache saved: ${id} (${snapCount} total for ${project})`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache save error: ${err.message}` }] };
            }
        }
    );

    // n2_kv_load — Load most recent snapshot
    server.registerTool(
        'n2_kv_load',
        {
            title: 'N2 KV Load',
            description: 'Load the most recent KV-Cache snapshot for a project. Returns compressed context.',
            inputSchema: {
                project: z.string().describe('Project name'),
                budget: z.number().optional().describe('Token budget for context (default: 2000)'),
                level: z.string().optional().describe('Progressive level: L1 (minimal), L2 (standard), L3 (full), auto (default)'),
            },
        },
        async ({ project, budget, level }) => {
            try {
                const snap = kvCache.load(project, { budget, level: level || 'auto' });
                if (!snap) {
                    return { content: [{ type: 'text', text: `No KV-Cache snapshots found for ${project}.` }] };
                }
                const header = `[${snap._level || 'auto'} | ~${snap._promptTokens || '?'} tokens]`;
                return {
                    content: [{
                        type: 'text',
                        text: `${header}\n${snap._resumePrompt || `Snapshot ${snap.id} loaded.`}`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache load error: ${err.message}` }] };
            }
        }
    );

    // n2_kv_search — Search across snapshots
    server.registerTool(
        'n2_kv_search',
        {
            title: 'N2 KV Search',
            description: 'Search across KV-Cache snapshots for relevant past sessions.',
            inputSchema: {
                query: z.string().describe('Search query (keywords, space-separated)'),
                project: z.string().describe('Project name'),
                maxResults: z.number().optional().describe('Max results (default: 5)'),
            },
        },
        async ({ query, project, maxResults }) => {
            try {
                const results = await kvCache.search(query, project, maxResults || 5);
                if (results.length === 0) {
                    return { content: [{ type: 'text', text: `No KV-Cache results for "${query}" in ${project}.` }] };
                }

                const lines = results.map((r, i) => {
                    const date = (r.endedAt || r.startedAt || '').split('T')[0];
                    return `${i + 1}. [${date}] ${r.agentName} | ${r.keys.slice(0, 5).join(', ')}\n   ${(r.context?.summary || '').slice(0, 150)}`;
                });

                return {
                    content: [{
                        type: 'text',
                        text: `KV-Cache search: "${query}" (${results.length} results)\n\n${lines.join('\n\n')}`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache search error: ${err.message}` }] };
            }
        }
    );

    // n2_kv_gc — Garbage collect old snapshots
    server.registerTool(
        'n2_kv_gc',
        {
            title: 'N2 KV Garbage Collect',
            description: 'Remove old KV-Cache snapshots. Uses config defaults if no args.',
            inputSchema: {
                project: z.string().describe('Project name'),
                maxAgeDays: z.number().optional().describe('Delete older than N days'),
            },
        },
        async ({ project, maxAgeDays }) => {
            try {
                const result = kvCache.gc(project, maxAgeDays);
                const remaining = kvCache.listSnapshots(project).length;
                return {
                    content: [{
                        type: 'text',
                        text: `KV-Cache GC: ${result.deleted} deleted, ${remaining} remaining for ${project}.`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache GC error: ${err.message}` }] };
            }
        }
    );

    // n2_kv_backup — Backup project data
    server.registerTool(
        'n2_kv_backup',
        {
            title: 'N2 KV Backup',
            description: 'Backup KV-Cache data to a portable SQLite DB. Supports incremental backups.',
            inputSchema: {
                project: z.string().describe('Project name'),
                full: z.boolean().optional().describe('Force full backup (ignore incremental)'),
            },
        },
        async ({ project, full }) => {
            try {
                const result = await kvCache.backup(project, { full });
                if (result.type === 'skip') {
                    return { content: [{ type: 'text', text: `KV-Cache backup skipped: ${result.message}` }] };
                }
                if (result.type === 'empty') {
                    return { content: [{ type: 'text', text: `KV-Cache backup: no data for ${project}.` }] };
                }
                return {
                    content: [{
                        type: 'text',
                        text: `KV-Cache backup created: ${result.backupId}\nType: ${result.type} | Size: ${result.sizeFormatted}\nSnapshots: ${result.snapshots || 'copied'} | Embeddings: ${result.embeddings || 'included'}`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache backup error: ${err.message}` }] };
            }
        }
    );

    // n2_kv_restore — Restore from backup
    server.registerTool(
        'n2_kv_restore',
        {
            title: 'N2 KV Restore',
            description: 'Restore KV-Cache data from a backup DB.',
            inputSchema: {
                project: z.string().describe('Project name'),
                backupId: z.string().optional().describe('Backup ID (default: latest)'),
                target: z.string().optional().describe('Restore target: json (default) or sqlite'),
            },
        },
        async ({ project, backupId, target }) => {
            try {
                const result = await kvCache.restore(project, backupId, { target });
                if (result.error) {
                    return { content: [{ type: 'text', text: `KV-Cache restore error: ${result.error}` }] };
                }
                return {
                    content: [{
                        type: 'text',
                        text: `KV-Cache restored from ${result.backupId}: ${result.restored} snapshots, ${result.embeddings || 0} embeddings (target: ${result.target})`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache restore error: ${err.message}` }] };
            }
        }
    );

    // n2_kv_backup_list — List backup history
    server.registerTool(
        'n2_kv_backup_list',
        {
            title: 'N2 KV Backup List',
            description: 'List KV-Cache backup history for a project.',
            inputSchema: {
                project: z.string().describe('Project name'),
            },
        },
        async ({ project }) => {
            try {
                const backups = kvCache.listBackups(project);
                if (backups.length === 0) {
                    return { content: [{ type: 'text', text: `No backups for ${project}.` }] };
                }
                const status = kvCache.backupStatus(project);
                const lines = backups.map((b, i) =>
                    `${i + 1}. [${b.id}] ${b.type} | ${b.sizeFormatted} | ${b.timestamp?.split('T')[0]}`
                );
                return {
                    content: [{
                        type: 'text',
                        text: `KV-Cache backups for ${project}: ${status.totalBackups} total (${status.totalBackupSize})\nLast: ${status.lastBackup || 'never'}\n\n${lines.join('\n')}`,
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `KV-Cache backup list error: ${err.message}` }] };
            }
        }
    );
}

module.exports = { registerKVCacheTools };
