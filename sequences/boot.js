// Soul MCP — Boot sequence. Handoff + Entity/Core Memory injection + KV-Cache restore.
const path = require('path');
const pkg = require('../package.json');
const fs = require('fs');
const { readJson, today, nowISO, logError } = require('../lib/utils');
const { detectAgentsDir, listAgents } = require('../lib/agent-registry');
const { SoulEngine } = require('../lib/soul-engine');
const { setAgentName, setKvChainParent } = require('../lib/context');
const { EntityMemory } = require('../lib/entity-memory');
const { CoreMemory } = require('../lib/core-memory');

function registerBootSequence(server, z, config, workflows = {}) {
    const engine = new SoulEngine(config.DATA_DIR);
    const entityMemory = new EntityMemory(config.DATA_DIR);
    const coreMemory = new CoreMemory(config.DATA_DIR);

    server.registerTool(
        'n2_boot',
        {
            title: 'Soul Boot',
            description: 'Boot sequence — loads soul-board handoff, entity/core memory, agent list, and KV-Cache context.',
            inputSchema: {
                agent: z.string().describe('Agent name'),
                project: z.string().optional().describe('Project name to load context for'),
            },
        },
        async ({ agent, project }) => {
            const lines = [];

            // -- Agent resolution --
            const agentsDir = config.AGENTS_DIR || detectAgentsDir();
            const agents = listAgents(agentsDir);
            const agentName = agent || process.env.N2_AGENT_NAME || 'default';
            setAgentName(agentName);

            lines.push(`--- Soul Boot v${pkg.version} | ${agentName} | ${today()} ---`);
            if (agents.length > 0) {
                lines.push(`Agents: ${agents.map(a => `${a.name}[${a.model}]`).join(', ')}`);
            }


            // -- Soul Board: handoff + TODO (auto-detect latest project) --
            let targetProject = project;
            if (!targetProject) {
                const allProjects = engine.listAllProjects();
                if (allProjects.length > 0) {
                    targetProject = allProjects[0].name;
                    lines.push(`\n📍 Auto-detected latest project: ${targetProject}`);
                }
            }

            if (targetProject) {
                const board = engine.readBoard(targetProject);
                lines.push(`\n--- ${targetProject} | v${board.state.version || '?'} | ${board.state.health || '?'} ---`);

                if (board.handoff && board.handoff.summary) {
                    lines.push(`Handoff(${board.handoff.from}): ${board.handoff.summary}`);
                    if (board.handoff.todo && board.handoff.todo.length > 0) {
                        lines.push(`TODO: ${board.handoff.todo.join(' | ')}`);
                    }
                }

                const activeEntries = Object.entries(board.activeWork).filter(([_, v]) => v);
                if (activeEntries.length > 0) {
                    lines.push(`Active: ${activeEntries.map(([n, i]) => `${n}:${i.task}`).join(', ')}`);
                }

                if (board.decisions && board.decisions.length > 0) {
                    const recent = board.decisions.slice(-3);
                    lines.push(`Decisions: ${recent.map(d => `[${d.date}] ${d.what}`).join(' | ')}`);
                }
            }

            // -- KV-Cache auto-load --
            if (targetProject && config.KV_CACHE?.enabled && config.KV_CACHE?.autoLoadOnBoot) {
                try {
                    const { SoulKVCache } = require('../lib/kv-cache');
                    const kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);
                    const snap = kvCache.load(targetProject);
                    if (snap) {
                        setKvChainParent(targetProject, snap.id);
                        const level = snap._level || 'auto';
                        const tokens = snap._promptTokens || '?';
                        lines.push(`\nKV-Cache: ${level} | ~${tokens}t | ${snap.id.slice(0, 8)}`);
                        if (snap._resumePrompt) lines.push(snap._resumePrompt);
                    }
                } catch (e) { logError('boot:kv-cache', e); }
            }

            // -- Entity Memory: inject known entities summary --
            try {
                entityMemory.invalidateCache(); // fresh read on each boot
                const entityCtx = entityMemory.toContext(10);
                if (entityCtx) lines.push(`\n${entityCtx}`);
            } catch (e) {
                logError('boot:entity-memory', e);
                lines.push(`\n⚠️ Entity Memory: ${e.message}`);
            }

            // -- Core Memory: inject agent-specific core facts --
            try {
                coreMemory.invalidateCache(); // fresh read on each boot
                const coreCtx = coreMemory.toPrompt(agentName, 500);
                if (coreCtx) lines.push(coreCtx);
            } catch (e) {
                logError('boot:core-memory', e);
                lines.push(`⚠️ Core Memory: ${e.message}`);
            }

            // -- Workflow auto-injection: session_start triggers --
            const bootWorkflows = Object.values(workflows).filter(
                w => w.trigger === 'session_start'
            );
            if (bootWorkflows.length > 0) {
                lines.push('\n═══ MANDATORY BOOT STEPS (auto-injected by @workflow) ═══');
                for (const wf of bootWorkflows) {
                    const requiredSteps = wf.steps.filter(s => s.required);
                    for (const step of requiredSteps) {
                        lines.push(`⚠️ REQUIRED: ${step.action || step.name}`);
                    }
                }
                lines.push('You MUST execute ALL required steps above before proceeding.');
                lines.push('═════════════════════════════════════════════════════');
            }

            lines.push(`\n--- Soul Boot v${pkg.version} complete ---`);
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
    );
}

module.exports = { registerBootSequence };
