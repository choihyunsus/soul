// Soul MCP v9.0 - Work sequence. Real-time change tracking, file ownership, context search.
import fs from 'fs';
import { WorkStore } from '../lib/work-store';
import { canonicalAgent } from '../lib/continuity';
import path from 'path';
import type { z as ZodType } from 'zod';
import { readJson, readFile, validateFirstLineComment, logError } from '../lib/utils';
import type { SoulEngine } from '../lib/soul-engine';
import type { McpToolServer, SoulConfig, FileChange } from '../types';

interface SearchResultItem {
  source: string;
  path: string;
  score: number;
  matchedKeywords: string[];
  preview: string;
  timestamp?: string;
  agent?: string;
  title?: string;
}

// Work records survive process restarts; retained for old callers that dispose timers.
export function disposeWorkSequence(): void {}

// -- Helper: recursively walk files (with cap to prevent event loop blocking) --
function walkFiles(dir: string, callback: (filePath: string) => void, maxDepth: number, depth: number = 0, counter?: { n: number; max: number }): void {
  const c = counter ?? { n: 0, max: 200 };
  if (depth > maxDepth || c.n >= c.max) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (c.n >= c.max) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(fullPath, callback, maxDepth, depth + 1, c);
      } else {
        callback(fullPath);
        c.n++;
      }
    }
  } catch (e) {
    logError('walkFiles', `${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface WorkStartInput { agent: string; project: string; task: string }
interface WorkClaimInput { project: string; agent: string; filePath: string; intent: string }
interface WorkLogInput {
  agent?: string; sessionId?: string;
  project: string;
  filesCreated?: FileChange[];
  filesModified?: FileChange[];
  filesDeleted?: FileChange[];
  decisions?: string[];
}
interface ContextSearchInput {
  query: string;
  sources?: string[];
  maxResults?: number;
  semantic?: boolean;
}

interface ScoreCfg {
  previewLen: number;
  recencyBonus: number;
}

/** Score text against keywords and push matches to results */
function _scoreText(
  text: string, filePath: string, source: string,
  keywords: string[], cfg: ScoreCfg, results: SearchResultItem[],
  meta: Partial<SearchResultItem> = {},
): void {
  if (!text) return;
  const lower = text.toLowerCase();
  let score = 0;
  const matchedKeywords: string[] = [];
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (lower.match(new RegExp(escaped, 'g')) || []).length;
    if (count > 0) { score += count; matchedKeywords.push(kw); }
  }
  if (score > 0) {
    if (meta.timestamp) {
      const age = (Date.now() - new Date(meta.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      score += Math.max(0, cfg.recencyBonus - age);
    }
    results.push({
      source, path: filePath,
      score: Math.round(score * 100) / 100,
      matchedKeywords,
      preview: text.slice(0, cfg.previewLen).replace(/\n/g, ' '),
      ...meta,
    });
  }
}

/** Search brain memory directory */
function _searchBrain(
  dataDir: string, keywords: string[], cfg: ScoreCfg, maxDepth: number, results: SearchResultItem[],
): void {
  const memoryDir = path.join(dataDir, 'memory');
  if (!fs.existsSync(memoryDir)) return;
  walkFiles(memoryDir, (fp) => {
    const content = readFile(fp);
    if (content) {
      const relPath = path.relative(memoryDir, fp);
      _scoreText(content, `memory/${relPath}`, 'brain', keywords, cfg, results, {
        timestamp: fs.statSync(fp).mtime.toISOString(),
      });
    }
  }, maxDepth);
}

interface LedgerEntry { title?: string; summary?: string; decisions?: string[]; completedAt?: string; startedAt?: string; agent?: string }

/** Search ledger entries */
function _searchLedger(
  dataDir: string, keywords: string[], cfg: ScoreCfg, maxDepth: number, results: SearchResultItem[],
): void {
  const projectsDir = path.join(dataDir, 'projects');
  if (!fs.existsSync(projectsDir)) return;
  for (const proj of fs.readdirSync(projectsDir)) {
    const ledgerBase = path.join(projectsDir, proj, 'ledger');
    if (!fs.existsSync(ledgerBase)) continue;
    walkFiles(ledgerBase, (fp) => {
      if (!fp.endsWith('.json')) return;
      const data = readJson<LedgerEntry>(fp);
      if (!data) return;
      const decisions = Array.isArray(data.decisions) ? data.decisions : [];
      const text = [data.title ?? '', data.summary ?? '', ...decisions].filter(Boolean).join(' ');
      const relPath = path.relative(projectsDir, fp);
      _scoreText(text, `projects/${relPath}`, 'ledger', keywords, cfg, results, {
        timestamp: data.completedAt ?? data.startedAt ?? '',
        agent: data.agent ?? '',
        title: data.title ?? '',
      });
    }, maxDepth);
  }
}

/** Format search results for display */
function _formatSearchResults(query: string, top: SearchResultItem[]): string {
  const lines = top.map((r, i) => {
    const icon = r.source === 'brain' ? '🧠' : '📖';
    const meta = [
      r.title ? `"${r.title}"` : '',
      r.agent ? `by ${r.agent}` : '',
      `score: ${r.score}`,
    ].filter(Boolean).join(' | ');
    return `${i + 1}. ${icon} ${r.path}\n   ${meta}\n   Keywords: [${r.matchedKeywords.join(', ')}]\n   ${r.preview}`;
  });
  return `🔍 Context search: "${query}" (${top.length} results)\n\n${lines.join('\n\n')}`;
}


export function registerWorkSequence(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
  engine: SoulEngine,
): void {
  const store = new WorkStore(config.DATA_DIR);
  server.tool('n2_work_sessions', 'List unfinished work and completed work with pending Mimir collection; use the exact sessionId to resume.',
    { project: z.string().optional() }, async ({ project }: { project?: string }) => ({
      content: [{ type: 'text', text: JSON.stringify(store.pending(project).map(r => ({ sessionId: r.id, project: r.project, agent: r.agent, task: r.task, startedAt: r.startedAt, ending: !!r.ending, completed: !!r.completed, learningStatus: r.learningStatus }))) }],
    }));
  _registerWorkStartTool(server, z, engine, store);
  _registerWorkClaimTool(server, z, engine, store);
  _registerWorkLogTool(server, z, store);
  _registerContextSearchTool(server, z, config);
}

/** Register n2_work_start tool */
function _registerWorkStartTool(server: McpToolServer, z: typeof ZodType, engine: SoulEngine, store: WorkStore): void {
  server.tool(
    'n2_work_start',
    'Start a work sequence. Registers agent in activeWork on soul-board.',
    {
      agent: z.string().describe('Agent name'),
      project: z.string().describe('Project name'),
      task: z.string().describe('Task description'),
    },
    async ({ agent, project, task }: WorkStartInput) => {
      agent = canonicalAgent(agent);
      const release = store.lock(project);
      try {
        engine.setActiveWork(project, agent, task, []);
        const record = store.start(project, agent, task);
        return { content: [{ type: 'text', text: `Work started: ${agent} on ${project} — ${task}\nsessionId: ${record.id} (use for work_log and work_end)` }] };
      } finally { release(); }
    },
  );
}

/** Register n2_work_claim tool */
function _registerWorkClaimTool(server: McpToolServer, z: typeof ZodType, engine: SoulEngine, store: WorkStore): void {
  server.tool(
    'n2_work_claim',
    'Claim file ownership before modifying. Prevents collision with other agents.',
    {
      project: z.string().describe('Project name'),
      agent: z.string().describe('Agent name'),
      filePath: z.string().describe('File path relative to project root'),
      intent: z.string().describe('Why you are modifying this file'),
    },
    async ({ project, agent, filePath, intent }: WorkClaimInput) => {
      const release = store.lock(project);
      let result;
      try { result = engine.claimFile(project, filePath, canonicalAgent(agent), intent); }
      finally { release(); }
      if (!result.ok) {
        return { content: [{ type: 'text', text: `COLLISION: ${filePath} is owned by ${result.owner ?? '?'} (${result.intent ?? '?'}). Choose a different file.` }] };
      }
      return { content: [{ type: 'text', text: `Claimed: ${filePath} -> ${agent} (${intent})` }] };
    },
  );
}

/** Register n2_work_log tool */
function _registerWorkLogTool(server: McpToolServer, z: typeof ZodType, store: WorkStore): void {
  server.tool(
    'n2_work_log',
    'Log file changes during work. Reports created/modified/deleted files with descriptions.',
    {
      project: z.string().describe('Project name'),
      agent: z.string().optional(),
      sessionId: z.string().optional(),
      filesCreated: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files created'),
      filesModified: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files modified'),
      filesDeleted: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files deleted'),
      decisions: z.array(z.string()).optional().describe('Decisions made'),
    },
    async ({ project, agent, sessionId, filesCreated, filesModified, filesDeleted, decisions }: WorkLogInput) => {
      const release = store.lock(project);
      try {
      const session = store.resolve(project, agent, sessionId);
      if (session.completed || session.ending) throw new Error('Work is ending or completed; log cannot be changed');
      if (filesCreated) session.filesCreated.push(...filesCreated);
      if (filesModified) session.filesModified.push(...filesModified);
      if (filesDeleted) session.filesDeleted.push(...filesDeleted);
      if (decisions) session.decisions.push(...decisions);

      store.save(session);
      const warnings: string[] = [];
      for (const f of (filesCreated ?? [])) {
        try {
          const fullPath = path.resolve(f.path);
          if (!validateFirstLineComment(fullPath)) warnings.push(`MISSING first-line comment: ${f.path}`);
        } catch (e) { logError('work:validate', e); }
      }

      const total = session.filesCreated.length + session.filesModified.length + session.filesDeleted.length;
      let msg = `Logged: ${total} file changes, ${session.decisions.length} decisions.`;
      if (warnings.length > 0) msg += `\nWARNINGS:\n  ${warnings.join('\n  ')}`;
      if ((filesCreated && filesCreated.length > 0) || (filesDeleted && filesDeleted.length > 0)) {
        msg += `\nUse n2_project_scan with the intended project root to refresh its file tree.`;
      }

      return { content: [{ type: 'text', text: msg }] };
      } finally { release(); }
    },
  );
}

/** Register n2_context_search tool */
function _registerContextSearchTool(server: McpToolServer, z: typeof ZodType, config: SoulConfig): void {
  server.tool(
    'n2_context_search',
    'Search across Brain memory and Ledger entries for relevant past context. Uses keyword matching with recency weighting.',
    {
      query: z.string().describe('Search query (keywords, space-separated)'),
      sources: z.array(z.string()).optional().describe('Sources to search: "brain", "ledger". Default: all.'),
      maxResults: z.number().optional().describe('Max results (default: 10)'),
      semantic: z.boolean().optional().describe('Enable semantic search via Ollama embeddings (default: auto from config)'),
    },
    async ({ query, sources, maxResults }: ContextSearchInput) => {
      try {
        const searchCfg = config.SEARCH ?? {};
        const minKwLen = searchCfg.minKeywordLength ?? 2;
        const max = maxResults ?? searchCfg.defaultMaxResults ?? 10;
        const searchSources = sources ?? ['brain', 'ledger'];
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= minKwLen);
        const results: SearchResultItem[] = [];
        const scoreCfg = { previewLen: searchCfg.previewLength ?? 200, recencyBonus: searchCfg.recencyBonus ?? 10 };

        if (searchSources.includes('brain')) {
          _searchBrain(config.DATA_DIR, keywords, scoreCfg, searchCfg.maxDepth ?? 6, results);
        }
        if (searchSources.includes('ledger')) {
          _searchLedger(config.DATA_DIR, keywords, scoreCfg, searchCfg.maxDepth ?? 6, results);
        }

        results.sort((a, b) => b.score - a.score);
        const top = results.slice(0, max);
        if (top.length === 0) {
          return { content: [{ type: 'text', text: `🔍 No results for "${query}".` }] };
        }
        return { content: [{ type: 'text', text: _formatSearchResults(query, top) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `❌ Search error: ${msg}` }] };
      }
    },
  );
}

