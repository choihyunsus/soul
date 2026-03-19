// Soul MCP v6.0 — Work sequence. Real-time change tracking, file ownership, context search.
const fs = require('fs');
const path = require('path');
const { nowISO, readJson, readFile, validateFirstLineComment, logError } = require('../lib/utils');
const { SoulEngine } = require('../lib/soul-engine');

// In-memory work session state per project
const activeSessions = {};

// TTL: auto-expire stale sessions (24 hours, checked every hour)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const _sessionGcTimer = setInterval(() => {
    const now = Date.now();
    for (const [project, session] of Object.entries(activeSessions)) {
        if (session._createdMs && (now - session._createdMs) > SESSION_TTL_MS) {
            delete activeSessions[project];
            logError('work:ttl', `Expired stale session: ${project} (agent: ${session.agent})`);
        }
    }
}, 60 * 60 * 1000);
_sessionGcTimer.unref(); // Don't prevent Node.js from exiting

// ── Helper: recursively walk files in a directory ──
function walkFiles(dir, callback, maxDepth, depth = 0) {
    if (depth > maxDepth) return;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkFiles(fullPath, callback, maxDepth, depth + 1);
            } else {
                callback(fullPath);
            }
        }
    } catch (e) {
        logError("walkFiles", `${dir}: ${e.message}`);
    }
}

function registerWorkSequence(server, z, config) {
    const engine = new SoulEngine(config.DATA_DIR);

    // Start a work sequence
    server.registerTool(
        'n2_work_start',
        {
            title: 'N2 Work Start',
            description: 'Start a work sequence. Registers agent in activeWork on soul-board.',
            inputSchema: {
                agent: z.string().describe('Agent name'),
                project: z.string().describe('Project name'),
                task: z.string().describe('Task description'),
            },
        },
        async ({ agent, project, task }) => {
            engine.setActiveWork(project, agent, task, []);
            activeSessions[project] = {
                agent,
                task,
                startedAt: nowISO(),
                _createdMs: Date.now(),
                filesCreated: [],
                filesModified: [],
                filesDeleted: [],
                decisions: [],
            };
            return { content: [{ type: 'text', text: `Work started: ${agent} on ${project} — ${task}` }] };
        }
    );

    // Claim file ownership before editing
    server.registerTool(
        'n2_work_claim',
        {
            title: 'N2 Work Claim',
            description: 'Claim file ownership before modifying. Prevents collision with other agents.',
            inputSchema: {
                project: z.string().describe('Project name'),
                agent: z.string().describe('Agent name'),
                filePath: z.string().describe('File path relative to project root'),
                intent: z.string().describe('Why you are modifying this file'),
            },
        },
        async ({ project, agent, filePath, intent }) => {
            const result = engine.claimFile(project, filePath, agent, intent);
            if (!result.ok) {
                return { content: [{ type: 'text', text: `COLLISION: ${filePath} is owned by ${result.owner} (${result.intent}). Choose a different file.` }] };
            }
            return { content: [{ type: 'text', text: `Claimed: ${filePath} -> ${agent} (${intent})` }] };
        }
    );

    // Log file changes during work
    server.registerTool(
        'n2_work_log',
        {
            title: 'N2 Work Log',
            description: 'Log file changes during work. Reports created/modified/deleted files with descriptions.',
            inputSchema: {
                project: z.string().describe('Project name'),
                filesCreated: z.array(z.object({
                    path: z.string(),
                    desc: z.string(),
                })).optional().describe('Files created'),
                filesModified: z.array(z.object({
                    path: z.string(),
                    desc: z.string(),
                })).optional().describe('Files modified'),
                filesDeleted: z.array(z.object({
                    path: z.string(),
                    desc: z.string(),
                })).optional().describe('Files deleted'),
                decisions: z.array(z.string()).optional().describe('Decisions made'),
            },
        },
        async ({ project, filesCreated, filesModified, filesDeleted, decisions }) => {
            const session = activeSessions[project];
            if (!session) {
                return { content: [{ type: 'text', text: 'ERROR: No active work session. Call n2_work_start first.' }] };
            }

            if (filesCreated) session.filesCreated.push(...filesCreated);
            if (filesModified) session.filesModified.push(...filesModified);
            if (filesDeleted) session.filesDeleted.push(...filesDeleted);
            if (decisions) session.decisions.push(...decisions);

            // Validate first-line comments on created files
            const warnings = [];
            for (const f of (filesCreated || [])) {
                try {
                    const fullPath = path.resolve(f.path);
                    if (!validateFirstLineComment(fullPath)) {
                        warnings.push(`MISSING first-line comment: ${f.path}`);
                    }
                } catch (e) { logError("work:validate", e); }
            }

            const total = (session.filesCreated.length + session.filesModified.length + session.filesDeleted.length);
            let msg = `Logged: ${total} file changes, ${session.decisions.length} decisions.`;
            if (warnings.length > 0) {
                msg += `\nWARNINGS:\n  ${warnings.join('\n  ')}`;
            }
            if ((filesCreated && filesCreated.length > 0) || (filesDeleted && filesDeleted.length > 0)) {
                msg += `\nFile tree will auto-update at n2_work_end. Use n2_project_scan for immediate refresh.`;
            }
            msg += `\nTODO RULE: All TODO files go in _data/ ONLY. Always mark completed items as [x]. Never use brain memory for TODOs.`;
            return { content: [{ type: 'text', text: msg }] };
        }
    );

    // ── n2_context_search: Search across Brain memory and Ledger entries ──
    server.registerTool(
        'n2_context_search',
        {
            title: 'N2 Context Search',
            description: 'Search across Brain memory and Ledger entries for relevant past context. Uses keyword matching with recency weighting. Great for finding related past work or decisions.',
            inputSchema: {
                query: z.string().describe('Search query (keywords, space-separated)'),
                sources: z.array(z.string()).optional().describe('Sources to search: "brain", "ledger". Default: all.'),
                maxResults: z.number().optional().describe('Max results (default: 10)'),
            },
        },
        async ({ query, sources, maxResults }) => {
            try {
                const dataDir = config.DATA_DIR;
                const searchCfg = config.SEARCH || {};
                const minKwLen = searchCfg.minKeywordLength || 2;
                const previewLen = searchCfg.previewLength || 200;
                const recencyBonus = searchCfg.recencyBonus || 10;
                const maxDepth = searchCfg.maxDepth || 6;
                const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= minKwLen);
                const max = maxResults || searchCfg.defaultMaxResults || 10;
                const searchSources = sources || ['brain', 'ledger'];
                const results = [];

                function scoreText(text, filePath, source, meta = {}) {
                    if (!text) return;
                    const lower = text.toLowerCase();
                    let score = 0;
                    const matchedKeywords = [];
                    for (const kw of keywords) {
                        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const count = (lower.match(new RegExp(escaped, 'g')) || []).length;
                        if (count > 0) { score += count; matchedKeywords.push(kw); }
                    }
                    if (score > 0) {
                        if (meta.timestamp) {
                            const age = (Date.now() - new Date(meta.timestamp).getTime()) / (1000 * 60 * 60 * 24);
                            score += Math.max(0, recencyBonus - age);
                        }
                        results.push({
                            source, path: filePath,
                            score: Math.round(score * 100) / 100,
                            matchedKeywords,
                            preview: text.slice(0, previewLen).replace(/\n/g, ' '),
                            ...meta,
                        });
                    }
                }

                // Search Brain memory
                if (searchSources.includes('brain')) {
                    const memoryDir = path.join(dataDir, 'memory');
                    if (fs.existsSync(memoryDir)) {
                        walkFiles(memoryDir, (fp) => {
                            const content = readFile(fp);
                            if (content) {
                                const relPath = path.relative(memoryDir, fp);
                                scoreText(content, `memory/${relPath}`, 'brain', {
                                    timestamp: fs.statSync(fp).mtime.toISOString(),
                                });
                            }
                        }, maxDepth);
                    }
                }

                // Search Ledger entries
                if (searchSources.includes('ledger')) {
                    const projectsDir = path.join(dataDir, 'projects');
                    if (fs.existsSync(projectsDir)) {
                        for (const proj of fs.readdirSync(projectsDir)) {
                            const ledgerBase = path.join(projectsDir, proj, 'ledger');
                            if (!fs.existsSync(ledgerBase)) continue;
                            walkFiles(ledgerBase, (fp) => {
                                if (!fp.endsWith('.json')) return;
                                const data = readJson(fp);
                                if (!data) return;
                                const text = [data.title, data.summary, ...(data.decisions || [])].filter(Boolean).join(' ');
                                const relPath = path.relative(projectsDir, fp);
                                scoreText(text, `projects/${relPath}`, 'ledger', {
                                    timestamp: data.completedAt || data.startedAt,
                                    agent: data.agent,
                                    title: data.title,
                                });
                            }, maxDepth);
                        }
                    }
                }

                results.sort((a, b) => b.score - a.score);
                const top = results.slice(0, max);

                if (top.length === 0) {
                    return { content: [{ type: 'text', text: `🔍 No results for "${query}".` }] };
                }

                const lines = top.map((r, i) => {
                    const icon = r.source === 'brain' ? '🧠' : '📖';
                    const meta = [
                        r.title ? `"${r.title}"` : '',
                        r.agent ? `by ${r.agent}` : '',
                        `score: ${r.score}`,
                    ].filter(Boolean).join(' | ');
                    return `${i + 1}. ${icon} ${r.path}\n   ${meta}\n   Keywords: [${r.matchedKeywords.join(', ')}]\n   ${r.preview}`;
                });

                return {
                    content: [{
                        type: 'text', text:
                            `🔍 Context search: "${query}" (${top.length} results)\n\n${lines.join('\n\n')}`
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `❌ Search error: ${err.message}` }] };
            }
        }
    );
}

// Export activeSessions for end.js to access
module.exports = { registerWorkSequence, activeSessions };
