// Soul MCP v9.0 - End sequence. Ledger + board handoff + KV-Cache + entities/insights auto-save.
import path from 'path';
import type { z as ZodType } from 'zod';
import { nowISO, readFile, writeFile, logError } from '../lib/utils';
import type { SoulEngine } from '../lib/soul-engine';
import { getKvChainParent, setKvChainParent } from '../lib/context';
import { WorkStore } from '../lib/work-store';
import type { WorkRecord } from '../lib/work-store';
import { canonicalAgent } from '../lib/continuity';
import { memorySegment } from '../lib/kv-cache/atomic-json';
import { EntityMemory } from '../lib/entity-memory';
import type { EntityInput } from '../lib/entity-memory';
import type { McpToolServer, SoulConfig } from '../types';
import { mimirDigest } from '../tools/mimir-lifecycle';
import { redactMemory } from '../lib/recall';

interface WorkEndInput {
  sessionId?: string;
  agent: string;
  project: string;
  title: string;
  summary: string;
  todo?: string[];
  decisions?: string[];
  entities?: EntityInput[];
  insights?: string[];
}

type ActiveSession = WorkRecord;

/** Write immutable ledger entry */
function _writeLedger(
  engine: SoulEngine, project: string, agent: string, title: string,
  summary: string, session: ActiveSession, allDecisions: string[],
): { id: string; path: string } {
  return engine.writeLedger(project, agent, {
    operationId: session.id,
    startedAt: session.startedAt,
    title, summary,
    filesCreated: session.filesCreated ?? [],
    filesModified: session.filesModified ?? [],
    filesDeleted: session.filesDeleted ?? [],
    decisions: allDecisions,
  });
}

/** Update soul-board handoff */
function _updateBoardHandoff(
  engine: SoulEngine, config: SoulConfig, project: string,
  agent: string, summary: string, todo: string[], allDecisions: string[], decisionDate: string,
): void {
  const board = engine.readBoard(project);
  board.handoff = { from: agent, summary, todo, blockers: [] };
  const dateStr = decisionDate;
  for (const d of allDecisions) {
    if (!board.decisions.some(item => item.by === agent && item.what === d && item.date === dateStr)) board.decisions.push({ date: dateStr, by: agent, what: d, why: '' });
  }
  const maxDecisions = config.WORK?.maxDecisions ?? 20;
  if (board.decisions.length > maxDecisions) {
    board.decisions = board.decisions.slice(-maxDecisions);
  }
  board.updatedBy = agent;
  engine.writeBoard(project, board);
}

/** Release ownership only when no other session by this agent needs it. */
function _runCleanup(engine: SoulEngine, store: WorkStore, project: string, agent: string, id: string): void {
  if (!store.active(project, agent).some(record => record.id !== id)) {
    engine.releaseFiles(project, agent);
    engine.clearActiveWork(project, agent);
  }
  // Project roots require explicit n2_project_scan; do not index the Soul host by mistake.
  // Historical ledgers are retained, never pruned as a side effect of ending work.
}

/** Save KV-Cache snapshot + auto-GC */
async function _saveKvCache(
  config: SoulConfig, agent: string, project: string,
  summary: string, allDecisions: string[], todo: string[], session: ActiveSession,
): Promise<void> {
  if (!config.KV_CACHE?.enabled || !config.KV_CACHE?.autoSaveOnWorkEnd) return;
  let kvCache: InstanceType<typeof import('../lib/kv-cache').SoulKVCache> | null = null;
  try {
    const { SoulKVCache } = await import('../lib/kv-cache');
    kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);
    await kvCache.ready();
    if (await kvCache.snapshot.loadById(project, session.id)) return;
    const parentId = getKvChainParent(project, agent);
    const id = await kvCache.save(agent, project, {
      id: session.id, summary, decisions: allDecisions, todo,
      filesCreated: session.filesCreated ?? [],
      filesModified: session.filesModified ?? [],
      filesDeleted: session.filesDeleted ?? [],
      startedAt: session.startedAt,
      parentSessionId: parentId,
    });
    if (!await kvCache.snapshot.loadById(project, id)) throw new Error('Checkpoint read-back failed');
    setKvChainParent(project, id, agent);
    const maxSnapshots = config.KV_CACHE?.maxSnapshotsPerProject ?? 50;
    const snapCount = (await kvCache.listSnapshots(project)).length;
    if (snapCount > maxSnapshots) await kvCache.gc(project);
  } catch (e) {
    logError('end:kv-cache', e);
    throw e;
  } finally {
    if (kvCache) kvCache.dispose();
  }
}

/** Save entities and insights to memory */
function _saveEntitiesAndInsights(
  entityMemory: EntityMemory, config: SoulConfig,
  project: string, agent: string, title: string,
  entities?: EntityInput[], insights?: string[],
): void {
  if (entities && entities.length > 0) {
    try { entityMemory.upsertBatch(entities); } catch (e) { logError('end:entity-memory', e); }
  }
  if (insights && insights.length > 0) {
    try {
      const insightsDir = path.join(config.DATA_DIR, 'memory', 'auto-extract', memorySegment(project));
      const dateStr = nowISO().split('T')[0] ?? '';
      const filePath = path.join(insightsDir, `${dateStr}.md`);
      const newBlock = `# Auto-Extract: ${project}\n## ${agent} — ${title}\n\n${insights.map(i => `- ${i}`).join('\n')}\n`;
      const existing = readFile(filePath) ?? '';
      writeFile(filePath, existing + newBlock + '\n');
    } catch (e) { logError('end:insights', e); }
  }
}



/** Retryable auxiliary collection. Core checkpoint and ledger are already durable. */
async function _saveMimirReports(
  config: SoulConfig, store: WorkStore, session: ActiveSession, summary: string, decisions: string[],
): Promise<string> {
  try {
    const message = await mimirDigest(config, session.project, session.agent, {
      sessionId: session.id, summary, decisions,
      filesCreated: session.filesCreated, filesModified: session.filesModified,
    });
    session.learningStatus = 'saved';
    store.save(session);
    return message;
  } catch (error) {
    session.learningStatus = 'failed';
    store.save(session);
    const message = redactMemory(error instanceof Error ? error.message : String(error));
    return `Mimir report collection FAILED: ${message}. Core work saved; retry n2_work_end with the same sessionId and original payload.`;
  }
}

/** Execute work-end orchestration */
async function _handleWorkEnd(
  input: WorkEndInput, config: SoulConfig, engine: SoulEngine, entityMemory: EntityMemory,
): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> {
  const { project, title, summary, todo, decisions, entities, insights } = input;
  const agent = canonicalAgent(input.agent);
  const store = new WorkStore(config.DATA_DIR);
  const release = store.lock(project);
  try {
  const session = store.resolve(project, agent, input.sessionId);
  const ending = JSON.stringify({ agent, project, title, summary, todo, decisions, entities, insights });
  if (session.ending && session.ending !== ending) throw new Error('Retry with the original work_end payload; an incomplete end is already recorded');
  if (session.completed) {
    const learning = session.learningStatus && session.learningStatus !== 'saved'
      ? await _saveMimirReports(config, store, session, summary, [...new Set([...session.decisions, ...(decisions ?? [])])]) : '';
    return { content: [{ type: 'text', text: `Work already completed: ${session.id}\nLedger: ${session.ledger?.path}\n${learning}` }] };
  }
  session.ending = ending;
  store.save(session);
  const allDecisions = [...new Set([...(session.decisions ?? []), ...(decisions ?? [])])];
  // Persist checkpoint first. Stable IDs make retries safe after a crash at any subsequent step.
  await _saveKvCache(config, agent, project, summary, allDecisions, todo ?? [], session);
  const ledgerResult = _writeLedger(engine, project, agent, title, summary, session, allDecisions);
  session.ledger = ledgerResult;
  store.save(session);
  _updateBoardHandoff(engine, config, project, agent, summary, todo ?? [], allDecisions, session.startedAt.split('T')[0] ?? '');
  _runCleanup(engine, store, project, agent, session.id);
  session.completed = true;
  session.learningStatus = 'pending';
  store.save(session);
  _saveEntitiesAndInsights(entityMemory, config, project, agent, title, entities, insights);

  const mimirMsg = await _saveMimirReports(config, store, session, summary, allDecisions);

  const totalFiles = (session.filesCreated ?? []).length +
    (session.filesModified ?? []).length + (session.filesDeleted ?? []).length;

  return {
    content: [{
      type: 'text',
      text: [
        `Work ${ledgerResult.id} completed: ${title}`,
        `Agent: ${agent}`, `Files: ${totalFiles} changes`,
        `Decisions: ${allDecisions.length}`,
        `Ledger: ${ledgerResult.path}`,
        `Handoff TODO: ${(todo ?? []).join(' | ') || 'none'}`,
        mimirMsg,
      ].filter(Boolean).join('\n'),
    }],
  };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: 'Work end failed; work remains active unless already completed. Retry with the same sessionId and payload. ' + (error instanceof Error ? error.message : String(error)) }] };
  } finally { release(); }
}

/** Register n2_work_end tool */
function _registerWorkEndTool(
  server: McpToolServer, z: typeof ZodType,
  config: SoulConfig, engine: SoulEngine, entityMemory: EntityMemory,
): void {
  server.tool(
    'n2_work_end',
    'End work sequence. Writes immutable ledger entry, updates soul-board handoff, releases file ownership.',
    {
      sessionId: z.string().optional().describe('Stable ID returned by work_start; required when multiple sessions exist'),
      agent: z.string().describe('Agent name'),
      project: z.string().describe('Project name'),
      title: z.string().describe('Work title'),
      summary: z.string().describe('Work summary'),
      todo: z.array(z.string()).optional().describe('Next TODO items'),
      decisions: z.array(z.string()).optional().describe('Key decisions made'),
      entities: z.array(z.object({
        type: z.string().describe('Entity type'),
        name: z.string().describe('Entity name'),
        attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      })).optional().describe('Entities discovered during session'),
      insights: z.array(z.string()).optional().describe('Permanent knowledge/insights to remember'),
    },
    async (input: WorkEndInput) => _handleWorkEnd(input, config, engine, entityMemory),
  );
}

export function registerEndSequence(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
  engine: SoulEngine,
): void {
  const entityMemory = new EntityMemory(config.DATA_DIR);
  _registerWorkEndTool(server, z, config, engine, entityMemory);
}


