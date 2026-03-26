// Soul MCP v9.0 — Work sequence. Real-time change tracking, file ownership, context search.
import fs from 'fs';
import path from 'path';
import type { z as ZodType } from 'zod';
import { nowISO, readJson, readFile, validateFirstLineComment, logError } from '../lib/utils';
import { SoulEngine } from '../lib/soul-engine';
import type { McpToolServer, SoulConfig, FileChange } from '../types';

interface WorkSession {
  agent: string;
  task: string;
  startedAt: string;
  _createdMs: number;
  filesCreated: FileChange[];
  filesModified: FileChange[];
  filesDeleted: FileChange[];
  decisions: string[];
}

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

// In-memory work session state per project
export const activeSessions: Record<string, WorkSession> = {};

// TTL: auto-expire stale sessions — initialized lazily in registerWorkSequence
let _sessionGcTimer: ReturnType<typeof setInterval> | null = null;

/** Cleanup GC timer — call in tests or before shutdown */
export function disposeWorkSequence(): void {
  if (_sessionGcTimer) {
    clearInterval(_sessionGcTimer);
    _sessionGcTimer = null;
  }
}

// ── Helper: recursively walk files ──
function walkFiles(dir: string, callback: (filePath: string) => void, maxDepth: number, depth: number = 0): void {
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
    logError('walkFiles', `${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface WorkStartInput { agent: string; project: string; task: string }
interface WorkClaimInput { project: string; agent: string; filePath: string; intent: string }
interface WorkLogInput {
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

export function registerWorkSequence(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
): void {
  const engine = new SoulEngine(config.DATA_DIR);

  // Initialize session TTL GC (uses the config passed to this function)
  if (!_sessionGcTimer) {
    const sessionTtlMs = (config.WORK?.sessionTtlHours ?? 24) * 60 * 60 * 1000;
    _sessionGcTimer = setInterval(() => {
      const now = Date.now();
      for (const [project, session] of Object.entries(activeSessions)) {
        if (session._createdMs && (now - session._createdMs) > sessionTtlMs) {
          delete activeSessions[project];
          logError('work:ttl', `Expired stale session: ${project} (agent: ${session.agent})`);
        }
      }
    }, 60 * 60 * 1000);
    _sessionGcTimer.unref();
  }

  // n2_work_start
  server.tool(
    'n2_work_start',
    'Start a work sequence. Registers agent in activeWork on soul-board.',
    {
      agent: z.string().describe('Agent name'),
      project: z.string().describe('Project name'),
      task: z.string().describe('Task description'),
    },
    async ({ agent, project, task }: WorkStartInput) => {
      engine.setActiveWork(project, agent, task, []);
      activeSessions[project] = {
        agent, task, startedAt: nowISO(), _createdMs: Date.now(),
        filesCreated: [], filesModified: [], filesDeleted: [], decisions: [],
      };
      return { content: [{ type: 'text', text: `Work started: ${agent} on ${project} — ${task}` }] };
    },
  );

  // n2_work_claim
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
      const result = engine.claimFile(project, filePath, agent, intent);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `COLLISION: ${filePath} is owned by ${result.owner ?? '?'} (${result.intent ?? '?'}). Choose a different file.` }] };
      }
      return { content: [{ type: 'text', text: `Claimed: ${filePath} -> ${agent} (${intent})` }] };
    },
  );

  // n2_work_log
  server.tool(
    'n2_work_log',
    'Log file changes during work. Reports created/modified/deleted files with descriptions.',
    {
      project: z.string().describe('Project name'),
      filesCreated: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files created'),
      filesModified: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files modified'),
      filesDeleted: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files deleted'),
      decisions: z.array(z.string()).optional().describe('Decisions made'),
    },
    async ({ project, filesCreated, filesModified, filesDeleted, decisions }: WorkLogInput) => {
      const session = activeSessions[project];
      if (!session) {
        return { content: [{ type: 'text', text: 'WARNING: No active work session. Logging skipped. Call n2_work_start for tracking.' }] };
      }

      if (filesCreated) session.filesCreated.push(...filesCreated);
      if (filesModified) session.filesModified.push(...filesModified);
      if (filesDeleted) session.filesDeleted.push(...filesDeleted);
      if (decisions) session.decisions.push(...decisions);

      // Validate first-line comments
      const warnings: string[] = [];
      for (const f of (filesCreated ?? [])) {
        try {
          const fullPath = path.resolve(f.path);
          if (!validateFirstLineComment(fullPath)) {
            warnings.push(`MISSING first-line comment: ${f.path}`);
          }
        } catch (e) { logError('work:validate', e); }
      }

      const total = session.filesCreated.length + session.filesModified.length + session.filesDeleted.length;
      let msg = `Logged: ${total} file changes, ${session.decisions.length} decisions.`;
      if (warnings.length > 0) {
        msg += `\nWARNINGS:\n  ${warnings.join('\n  ')}`;
      }
      if ((filesCreated && filesCreated.length > 0) || (filesDeleted && filesDeleted.length > 0)) {
        msg += `\nFile tree will auto-update at n2_work_end. Use n2_project_scan for immediate refresh.`;
      }
      msg += `\nTODO RULE: All TODO files go in _data/ ONLY. Always mark completed items as [x]. Never use brain memory for TODOs.`;
      return { content: [{ type: 'text', text: msg }] };
    },
  );

  // n2_context_search
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
        const dataDir = config.DATA_DIR;
        const searchCfg = config.SEARCH ?? {};
        const minKwLen = searchCfg.minKeywordLength ?? 2;
        const previewLen = searchCfg.previewLength ?? 200;
        const recencyBonus = searchCfg.recencyBonus ?? 10;
        const maxDepth = searchCfg.maxDepth ?? 6;
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= minKwLen);
        const max = maxResults ?? searchCfg.defaultMaxResults ?? 10;
        const searchSources = sources ?? ['brain', 'ledger'];
        const results: SearchResultItem[] = [];

        function scoreText(text: string, filePath: string, source: string, meta: Partial<SearchResultItem> = {}): void {
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

        if (searchSources.includes('ledger')) {
          const projectsDir = path.join(dataDir, 'projects');
          if (fs.existsSync(projectsDir)) {
            for (const proj of fs.readdirSync(projectsDir)) {
              const ledgerBase = path.join(projectsDir, proj, 'ledger');
              if (!fs.existsSync(ledgerBase)) continue;
              walkFiles(ledgerBase, (fp) => {
                if (!fp.endsWith('.json')) return;
                const data = readJson(fp) as Record<string, unknown> | null;
                if (!data) return;
                const text = [data['title'], data['summary'], ...((data['decisions'] as string[]) ?? [])].filter(Boolean).join(' ');
                const relPath = path.relative(projectsDir, fp);
                scoreText(text, `projects/${relPath}`, 'ledger', {
                  timestamp: String(data['completedAt'] ?? data['startedAt'] ?? ''),
                  agent: String(data['agent'] ?? ''),
                  title: String(data['title'] ?? ''),
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
            type: 'text', text: `🔍 Context search: "${query}" (${top.length} results)\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `❌ Search error: ${msg}` }] };
      }
    },
  );
}
