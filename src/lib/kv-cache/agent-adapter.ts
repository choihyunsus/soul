// Soul KV-Cache v9.0 — Agent adapter. Converts browser/MCP sessions to unified KV schema.
import { createSession } from './schema';
import type { SessionData } from './schema';

interface CheckpointAction {
  turn?: number;
  success?: boolean;
  summary?: string;
}

interface CheckpointData {
  id?: string;
  timestamp?: number;
  turnNumber?: number;
  progressSummary?: string;
  recentActions?: CheckpointAction[];
  remainingGoals?: string[];
}

interface MemoryNode {
  tags?: string[];
  content?: string;
}

interface FileChangeInput {
  path?: string;
}

interface McpSessionInput {
  agent?: string;
  project?: string;
  summary?: string;
  decisions?: string[];
  filesCreated?: (FileChangeInput | string)[];
  filesModified?: (FileChangeInput | string)[];
  filesDeleted?: (FileChangeInput | string)[];
  todo?: string[];
  startedAt?: string;
  parentSessionId?: string | null;
}

/** Converts CheckpointManager's CheckpointData to KV-Cache session schema */
export function fromCheckpoint(checkpoint: CheckpointData, projectName: string = 'default'): SessionData {
  const actions = checkpoint.recentActions || [];
  const decisions = actions
    .filter(a => a.success)
    .map(a => `Turn ${a.turn}: ${a.summary}`);

  return createSession({
    id: checkpoint.id,
    agentName: 'browser-executor',
    agentType: 'browser',
    startedAt: checkpoint.timestamp ? new Date(checkpoint.timestamp).toISOString() : undefined,
    turnCount: checkpoint.turnNumber || 0,
    keys: extractKeywords(checkpoint.progressSummary || ''),
    context: {
      summary: checkpoint.progressSummary || '',
      decisions,
      filesChanged: [],
      todo: checkpoint.remainingGoals || [],
    },
    projectName,
  });
}

/** Converts MemoryBridge MemoryNode array to KV-Cache entries */
export function fromMemoryBridge(
  nodes: MemoryNode[], owner: string = 'browser', projectName: string = 'default',
): SessionData {
  const allTags: string[] = [];
  const summaries: string[] = [];

  for (const node of nodes) {
    if (node.tags) allTags.push(...node.tags);
    if (node.content) summaries.push(node.content.slice(0, 200));
  }

  return createSession({
    agentName: owner,
    agentType: 'browser',
    keys: Array.from(new Set(allTags)),
    context: {
      summary: summaries.join('\n---\n'),
      decisions: [],
      filesChanged: [],
      todo: [],
    },
    projectName,
  });
}

/** Converts MCP n2_work_end session data to KV-Cache schema */
export function fromMcpSession(workEndData: McpSessionInput): SessionData {
  const d = workEndData || {};
  const extractPath = (f: FileChangeInput | string): string =>
    typeof f === 'string' ? f : (f.path || '');

  const filesChanged = [
    ...(d.filesCreated || []).map(extractPath),
    ...(d.filesModified || []).map(extractPath),
    ...(d.filesDeleted || []).map(extractPath),
  ];

  return createSession({
    agentName: d.agent || 'unknown',
    agentType: 'mcp',
    startedAt: d.startedAt,
    keys: extractKeywords(d.summary || ''),
    context: {
      summary: d.summary || '',
      decisions: d.decisions || [],
      filesChanged,
      todo: d.todo || [],
    },
    parentSessionId: d.parentSessionId || null,
    projectName: d.project || 'default',
  });
}

/** Generates a resume prompt from a snapshot within a token budget */
export function toResumePrompt(snapshot: SessionData | null, budgetTokens: number = 2000): string {
  if (!snapshot) return '';

  const lines: string[] = [];
  lines.push(`[Previous Session: ${snapshot.agentName} | ${snapshot.startedAt}]`);

  if (snapshot.keys.length > 0) {
    lines.push(`Topics: ${snapshot.keys.join(', ')}`);
  }
  if (snapshot.context.summary) {
    lines.push(`Summary: ${snapshot.context.summary}`);
  }
  if (snapshot.context.decisions.length > 0) {
    lines.push('Decisions:');
    for (const d of snapshot.context.decisions) lines.push(`  - ${d}`);
  }
  if (snapshot.context.todo.length > 0) {
    lines.push('TODO:');
    for (const t of snapshot.context.todo) lines.push(`  - ${t}`);
  }

  let result = lines.join('\n');
  const maxChars = budgetTokens * 3;
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n...(truncated)';
  }

  return result;
}

/** Simple keyword extraction from text. No LLM needed: frequency-based. */
export function extractKeywords(text: string, maxKeywords: number = 10): string[] {
  if (!text) return [];

  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at',
    'to', 'for', 'of', 'with', 'by', 'from', 'and', 'or', 'not',
    'this', 'that', 'it', 'as', 'be', 'has', 'have', 'had', 'do',
    'does', 'did', 'will', 'would', 'could', 'should', 'may', 'can',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  const freq: Record<string, number> = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}
