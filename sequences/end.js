// Soul MCP v6.0 — End sequence. Ledger + board handoff + KV-Cache + entities/insights auto-save.
const path = require('path');
const fs = require('fs');
const { nowISO, logError } = require('../lib/utils');
const { SoulEngine } = require('../lib/soul-engine');
const { popKvChainParent } = require('../lib/context');
const { activeSessions } = require('./work');
const { EntityMemory } = require('../lib/entity-memory');

function registerEndSequence(server, z, config) {
    const engine = new SoulEngine(config.DATA_DIR);
    const entityMemory = new EntityMemory(config.DATA_DIR);

    server.registerTool(
        'n2_work_end',
        {
            title: 'Soul Work End',
            description: 'End work sequence. Writes immutable ledger entry, updates soul-board handoff, releases file ownership.',
            inputSchema: {
                agent: z.string().describe('Agent name'),
                project: z.string().describe('Project name'),
                title: z.string().describe('Work title'),
                summary: z.string().describe('Work summary'),
                todo: z.array(z.string()).optional().describe('Next TODO items'),
                decisions: z.array(z.string()).optional().describe('Key decisions made'),
                entities: z.array(z.object({
                    type: z.string().describe('Entity type: person, hardware, project, concept, place, service'),
                    name: z.string().describe('Entity name'),
                    attributes: z.record(z.any()).optional().describe('Key-value attributes'),
                })).optional().describe('Entities discovered during session (auto-saved to Entity Memory)'),
                insights: z.array(z.string()).optional().describe('Permanent knowledge/insights to remember'),
            },
        },
        async ({ agent, project, title, summary, todo, decisions, entities, insights }) => {
            const session = activeSessions[project] || {};
            const allDecisions = [...(session.decisions || []), ...(decisions || [])];

            // 1. Write immutable ledger entry
            let ledgerResult;
            try {
                ledgerResult = engine.writeLedger(project, agent, {
                    startedAt: session.startedAt,
                    title,
                    summary,
                    filesCreated: session.filesCreated || [],
                    filesModified: session.filesModified || [],
                    filesDeleted: session.filesDeleted || [],
                    decisions: allDecisions,
                });
            } catch (e) {
                logError('end:ledger', e);
                return { content: [{ type: 'text', text: `❌ Ledger write failed: ${e.message}` }] };
            }

            // 2. Update soul-board handoff
            try {
                const board = engine.readBoard(project);
                board.handoff = {
                    from: agent,
                    summary,
                    todo: todo || [],
                    blockers: [],
                };

                const dateStr = nowISO().split('T')[0].slice(5);
                for (const d of allDecisions) {
                    board.decisions.push({ date: dateStr, by: agent, what: d, why: '' });
                }
                if (board.decisions.length > 20) {
                    board.decisions = board.decisions.slice(-20);
                }

                board.updatedBy = agent;
                engine.writeBoard(project, board);
            } catch (e) {
                logError('end:board', e);
            }

            // 3. Release file ownership
            engine.releaseFiles(project, agent);

            // 4. Clear active work
            engine.clearActiveWork(project, agent);

            // 5. Auto-update file-index tree
            try {
                const projectRoot = path.resolve(config.SOUL_ROOT, '..');
                const tree = engine.scanDirectory(projectRoot, {
                    maxDepth: config.SEARCH?.maxDepth || 4,
                });
                engine.writeFileIndex(project, { updatedAt: nowISO(), tree });
            } catch (e) {
                logError('end:file-index', e);
            }

            // 6. Clear in-memory session
            delete activeSessions[project];

            // 7. Auto-save KV-Cache snapshot (with session chaining)
            if (config.KV_CACHE?.enabled && config.KV_CACHE?.autoSaveOnWorkEnd) {
                try {
                    const { SoulKVCache } = require('../lib/kv-cache');
                    const kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);
                    const parentId = popKvChainParent(project);
                    kvCache.save(agent, project, {
                        summary,
                        decisions: allDecisions,
                        todo: todo || [],
                        filesCreated: session.filesCreated || [],
                        filesModified: session.filesModified || [],
                        filesDeleted: session.filesDeleted || [],
                        startedAt: session.startedAt,
                        parentSessionId: parentId,
                    });
                } catch (e) {
                    logError('end:kv-cache', e);
                }
            }

            // 8. Auto-save entities to Entity Memory
            if (entities && entities.length > 0) {
                try {
                    const result = entityMemory.upsertBatch(entities);
                    // result logged silently
                } catch (e) { logError('end:entity-memory', e); }
            }

            // 9. Save insights to memory
            if (insights && insights.length > 0) {
                try {
                    const insightsDir = path.join(config.DATA_DIR, 'memory', 'auto-extract', project);
                    if (!fs.existsSync(insightsDir)) fs.mkdirSync(insightsDir, { recursive: true });
                    const dateStr = nowISO().split('T')[0];
                    const filePath = path.join(insightsDir, `${dateStr}.md`);
                    const content = `# Auto-Extract: ${project}\n## ${agent} — ${title}\n\n${insights.map(i => `- ${i}`).join('\n')}\n`;
                    fs.appendFileSync(filePath, content + '\n', 'utf-8');
                } catch (e) { logError('end:insights', e); }
            }


            const totalFiles = (session.filesCreated || []).length +
                (session.filesModified || []).length +
                (session.filesDeleted || []).length;

            return {
                content: [{
                    type: 'text',
                    text: [
                        `Work ${ledgerResult.id} completed: ${title}`,
                        `Agent: ${agent}`,
                        `Files: ${totalFiles} changes`,
                        `Decisions: ${allDecisions.length}`,
                        `Ledger: ${ledgerResult.path}`,
                        `Handoff TODO: ${(todo || []).join(' | ') || 'none'}`,
                    ].join('\n'),
                }],
            };
        }
    );
}

module.exports = { registerEndSequence };
