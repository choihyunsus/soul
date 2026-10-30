// Soul MCP v9.0 - Boot sequence. Handoff + Entity/Core Memory injection + KV-Cache restore.
import type { z as ZodType } from 'zod';
import { today, logError } from '../lib/utils';
import { detectAgentsDir, listAgents } from '../lib/agent-registry';
import type { SoulEngine } from '../lib/soul-engine';
import { setAgentName, setKvChainParent } from '../lib/context';
import { EntityMemory } from '../lib/entity-memory';
import { CoreMemory } from '../lib/core-memory';
import { canonicalAgent } from '../lib/continuity';
import { WorkStore } from '../lib/work-store';
import { scopedMimirContext } from '../lib/mimir-recall';
import { redactMemory } from '../lib/recall';
import type { McpToolServer, BoardDecision, ActiveWork, SoulConfig } from '../types';
import pkg from '../../package.json';

interface BootInput {
  agent: string;
  project?: string;
}

interface WorkflowStep {
  required?: boolean;
  action?: string;
  name?: string;
}

interface Workflow {
  trigger: string;
  steps: WorkflowStep[];
}

/** Resolve agent name and list available agents */
function _resolveAgent(
  config: SoulConfig, agent: string,
): { agentName: string; agents: Array<{ name: string; model: string }> } {
  const agentsDir = config.AGENTS_DIR ?? detectAgentsDir();
  const agents = listAgents(agentsDir);
  const agentName = canonicalAgent(agent || process.env['N2_AGENT_NAME'] || 'default');
  setAgentName(agentName);
  return { agentName, agents };
}

/** Auto-detect project and load soul-board handoff context */
function _loadBoardContext(
  engine: SoulEngine, project: string | undefined, lines: string[],
): string | undefined {
  let targetProject = project;
  if (!targetProject) {
    const allProjects = engine.listAllProjects();
    const first = allProjects[0];
    if (first) {
      targetProject = first.name;
      lines.push(`\n📍 Auto-detected latest project: ${targetProject}`);
    }
  }

  if (targetProject) {
    const board = engine.readBoard(targetProject);
    lines.push(`\n--- ${targetProject} | v${board.state.version ?? '?'} | ${board.state.health ?? '?'} ---`);
    if (board.handoff?.summary) {
      lines.push(`Handoff(${board.handoff.from ?? '?'}): ${board.handoff.summary}`);
      if (board.handoff.todo?.length > 0) lines.push(`TODO: ${board.handoff.todo.join(' | ')}`);
    }
    const activeEntries = Object.entries(board.activeWork).filter(([, v]) => v !== null) as [string, ActiveWork][];
    if (activeEntries.length > 0) {
      lines.push(`Active: ${activeEntries.map(([n, i]) => `${n}:${i.task}`).join(', ')}`);
    }
    if (board.decisions?.length > 0) {
      const recent = board.decisions.slice(-3);
      lines.push(`Decisions: ${recent.map((d: BoardDecision) => `[${d.date}] ${d.what}`).join(' | ')}`);
    }
  }
  return targetProject;
}

/** Load KV-Cache snapshot and inject context */
async function _loadKvCache(
  config: SoulConfig, targetProject: string, agent: string, lines: string[],
): Promise<void> {
  if (!config.KV_CACHE?.enabled || !config.KV_CACHE?.autoLoadOnBoot) return;
  let kvCache: InstanceType<typeof import('../lib/kv-cache').SoulKVCache> | undefined;
  try {
    const { SoulKVCache } = await import('../lib/kv-cache');
    kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);
    interface KVSnap { id?: string; _level?: string; _promptTokens?: number; _resumePrompt?: string }
    const snap = await kvCache.load(targetProject, { agent }) as KVSnap | null;
    if (snap) {
      const snapId = snap.id ?? '';
      setKvChainParent(targetProject, snapId, agent);
      lines.push(`\nKV-Cache: ${snap._level ?? 'auto'} | ~${String(snap._promptTokens ?? '?')}t | ${snapId.slice(0, 8)}`);
      if (snap._resumePrompt) lines.push(snap._resumePrompt);
    }
  } catch (e) {
    logError('boot:kv-cache', e);
    lines.push(`Checkpoint restore failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally { kvCache?.dispose(); }
}

/** Inject entity and core memory context */
function _loadMemories(
  entityMemory: EntityMemory, coreMemory: CoreMemory, agentName: string, lines: string[],
): void {
  try {
    entityMemory.invalidateCache();
    const entityCtx = entityMemory.toContext(10);
    if (entityCtx) lines.push(`\n${entityCtx}`);
  } catch (e) {
    logError('boot:entity-memory', e);
    lines.push(`\n⚠️ Entity Memory: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    coreMemory.invalidateCache();
    const coreCtx = coreMemory.toPrompt(agentName, 500);
    if (coreCtx) lines.push(coreCtx);
  } catch (e) {
    logError('boot:core-memory', e);
    lines.push(`⚠️ Core Memory: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Inject mandatory workflow steps */
function _injectWorkflows(workflows: Record<string, Workflow>, lines: string[]): void {
  const bootWorkflows = Object.values(workflows).filter(w => w.trigger === 'session_start');
  if (bootWorkflows.length === 0) return;
  lines.push('\n═══ MANDATORY BOOT STEPS (auto-injected by @workflow) ═══');
  for (const wf of bootWorkflows) {
    for (const step of wf.steps.filter(s => s.required)) {
      lines.push(`⚠️ REQUIRED: ${step.action ?? step.name ?? ''}`);
    }
  }
  lines.push('You MUST execute ALL required steps above before proceeding.');
  lines.push('═════════════════════════════════════════════════════');
}


export function registerBootSequence(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
  engine: SoulEngine,
  workflows: Record<string, Workflow> = {},
): void {
  const entityMemory = new EntityMemory(config.DATA_DIR);
  const coreMemory = new CoreMemory(config.DATA_DIR);

  server.tool(
    'n2_boot',
    'Boot sequence — loads soul-board handoff, entity/core memory, agent list, and KV-Cache context.',
    {
      agent: z.string().describe('Agent name'),
      project: z.string().optional().describe('Project name to load context for'),
    },
    async ({ agent, project }: BootInput) => {
      const lines: string[] = [];
      const { agentName, agents } = _resolveAgent(config, agent);

      lines.push(`--- Soul Boot v${pkg.version} | ${agentName} | ${today()} ---`);
      if (agents.length > 0) {
        lines.push(`Agents: ${agents.map((a: { name: string; model: string }) => `${a.name}[${a.model}]`).join(', ')}`);
      }

      const targetProject = _loadBoardContext(engine, project, lines);

      lines.push('Historical references follow. Current instructions and current source code take precedence; old TODOs are not new requests. Board handoffs and entity memory are shared workspace records.');
      if (targetProject) {
        await _loadKvCache(config, targetProject, agentName, lines);
        const pending = new WorkStore(config.DATA_DIR).pending(targetProject).filter(s => s.agent === agentName);
        if (pending.length) lines.push('Unfinished/pending work: ' + JSON.stringify(pending.map(s => ({ sessionId: s.id, task: s.task, ending: !!s.ending, completed: !!s.completed, learningStatus: s.learningStatus }))));
        try {
          const recall = scopedMimirContext(config.DATA_DIR, targetProject, agentName);
          if (recall) lines.push(recall);
        } catch (error) { lines.push(`Learning recall failed: ${error instanceof Error ? error.message : String(error)}`); }
      }

      _loadMemories(entityMemory, coreMemory, agentName, lines);
      _injectWorkflows(workflows, lines);

      lines.push(`\n--- Soul Boot v${pkg.version} complete ---`);
      return { content: [{ type: 'text', text: redactMemory(lines.join('\n')) }] };
    },
  );
}

