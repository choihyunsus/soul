// Soul KV-Cache v9.0 - MCP tool registration. Exposes KV-Cache to agents.
import type { z as ZodType } from 'zod';
import { SoulKVCache } from '../lib/kv-cache';
import { getAgentName, getKvChainParent, setKvChainParent } from '../lib/context';
import { redactMemory } from '../lib/recall';
import { canonicalAgent } from '../lib/continuity';
import type { McpToolServer, SoulConfig } from '../types';

interface KVSaveInput {
  importance?: number;
  agent: string;
  project: string;
  summary: string;
  decisions?: string[];
  todo?: string[];
  filesCreated?: Array<{ path: string; desc: string }>;
  filesModified?: Array<{ path: string; desc: string }>;
}

interface KVLoadInput {
  agent?: string;
  project: string;
  budget?: number;
  level?: string;
}

interface KVSearchInput {
  query: string;
  project: string;
  agent?: string;
  maxResults?: number;
}

interface KVGcInput {
  project: string;
  maxAgeDays?: number;
}

interface KVBackupInput {
  project: string;
  full?: boolean;
}

interface KVRestoreInput {
  project: string;
  backupId?: string;
  target?: string;
}

interface KVBackupListInput {
  project: string;
}

// Backup types imported from ../lib/kv-cache/backup - no local duplicates needed

export function registerKVCacheTools(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
): void {
  if (!config.KV_CACHE?.enabled) return;
  const kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);

  _registerKVCoreTools(server, z, kvCache);
  _registerKVMaintenanceTools(server, z, kvCache);
  _registerKVBackupTools(server, z, kvCache);
}

/** Register n2_kv_save, n2_kv_load, n2_kv_search */
function _registerKVCoreTools(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  _registerKVSave(server, z, kvCache);
  _registerKVLoad(server, z, kvCache);
  _registerKVSearch(server, z, kvCache);
}

function _registerKVSave(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_save',
    'Save a durable checkpoint during work or before replying. does not finish active work.',
    {
      agent: z.string().describe('Agent name'),
      project: z.string().describe('Project name'),
      importance: z.number().min(0).max(1).optional().describe('0 to 1; values >= 0.8 are protected from automatic cleanup'),
      summary: z.string().describe('Session summary'),
      decisions: z.array(z.string()).optional().describe('Key decisions made'),
      todo: z.array(z.string()).optional().describe('TODO items for next session'),
      filesCreated: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files created'),
      filesModified: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files modified'),
    },
    async ({ agent, project, summary, decisions, todo, filesCreated, filesModified, importance }: KVSaveInput) => {
      try {
        const identity = canonicalAgent(agent);
        const id = await kvCache.save(identity, project, {
          summary, importance, decisions: decisions ?? [], todo: todo ?? [],
          parentSessionId: getKvChainParent(project, identity),
          filesCreated: filesCreated ?? [], filesModified: filesModified ?? [],
        });
        const saved = await kvCache.snapshot.loadById(project, id);
        if (!saved || saved.agentName !== identity || saved.projectName !== project) {
          throw new Error('Saved checkpoint could not be read back.');
        }
        setKvChainParent(project, id, identity);
        const snapCount = (await kvCache.listSnapshots(project)).length;
        return { content: [{ type: 'text', text: `KV-Cache saved: ${id} (${snapCount} total for ${project})` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `KV-Cache save error: ${msg}` }] };
      }
    },
  );
}

function _registerKVLoad(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_load',
    'Load the most recent KV-Cache snapshot for a project. Returns compressed context.',
    {
      project: z.string().describe('Project name'),
      agent: z.string().optional().describe('Identity; defaults to boot identity'),
      budget: z.number().int().min(1).max(32000).optional().describe('Token budget for context (default: 2000)'),
      level: z.string().optional().describe('Progressive level: L1 (minimal), L2 (standard), L3 (full), auto (default)'),
    },
    async ({ project, agent, budget, level }: KVLoadInput) => {
      try {
        const snap = await kvCache.load(project, { agent: agent ?? getAgentName(), budget, level: level ?? 'auto' });
        if (!snap) return { content: [{ type: 'text', text: `No KV-Cache snapshots found for ${project}.` }] };
        const header = `[${snap._level ?? 'auto'} | ~${snap._promptTokens ?? '?'} tokens]`;
        return { content: [{ type: 'text', text: `${header}\n${snap._resumePrompt ?? `Snapshot ${snap.id} loaded.`}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `KV-Cache load error: ${msg}` }] };
      }
    },
  );
}

function _registerKVSearch(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_search',
    'Read relevant historical snapshots for one project and agent (defaults to boot identity). Bounded lexical matching with domain aliases and correction precedence; source IDs and matched excerpts, no semantic-only ranking.',
    {
      query: z.string().describe('Search query (keywords, space-separated)'),
      project: z.string().describe('Project name'),
      agent: z.string().optional().describe('Memory identity; defaults to the booted agent'),
      maxResults: z.number().int().min(1).max(10).optional().describe('Max results (default: 5)'),
    },
    async ({ query, project, agent, maxResults }: KVSearchInput) => {
      try {
        const found = await kvCache.searchScoped(query, project, agent ?? getAgentName(), maxResults ?? 5);
        let text = '[Historical KV-Cache references; current user instructions take precedence. No result means no match within the search budget.]';
        for (const row of found.results) {
          const line = '\n' + JSON.stringify({ project, ...row, source: 'KV-Cache snapshot ' + row.id });
          if (Buffer.byteLength(text + line) > 5900) { found.limited = true; continue; }
          text += line;
        }
        if (found.limited) text += '\n[Search/output budget reached; additional records may exist.]';
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `KV-Cache search error: ${redactMemory(msg)}` }] };
      }
    },
  );
}

/** Register n2_kv_gc */
function _registerKVMaintenanceTools(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_gc',
    'Remove old KV-Cache snapshots. Uses config defaults if no args.',
    {
      project: z.string().describe('Project name'),
      maxAgeDays: z.number().int().min(0).optional().describe('Delete older than N days'),
    },
    async ({ project, maxAgeDays }: KVGcInput) => {
      try {
        const result = await kvCache.gc(project, maxAgeDays);
        const remaining = (await kvCache.listSnapshots(project)).length;
        return { content: [{ type: 'text', text: `KV-Cache GC: ${result.deleted} deleted, ${remaining} remaining for ${project}.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `KV-Cache GC error: ${msg}` }] };
      }
    },
  );
}

/** Register n2_kv_backup, n2_kv_restore, n2_kv_backup_list */
function _registerKVBackupTools(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  _registerKVBackup(server, z, kvCache);
  _registerKVRestore(server, z, kvCache);
  _registerKVBackupList(server, z, kvCache);
}

function _registerKVBackup(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_backup',
    'Backup KV-Cache data to a portable SQLite DB. Supports incremental backups.',
    {
      project: z.string().describe('Project name'),
      full: z.boolean().optional().describe('Force full backup (ignore incremental)'),
    },
    async ({ project, full }: KVBackupInput) => {
      try {
        const result = await kvCache.backup(project, { full });
        if (result.type === 'skip') return { content: [{ type: 'text', text: `KV-Cache backup skipped: ${result.message ?? ''}` }] };
        if (result.type === 'empty') return { content: [{ type: 'text', text: `KV-Cache backup: no data for ${project}.` }] };
        return {
          content: [{
            type: 'text',
            text: `KV-Cache backup created: ${result.backupId ?? ''}\nType: ${result.type} | Size: ${result.sizeFormatted ?? ''}\nSnapshots: ${String(result.snapshots ?? 'copied')} | Embeddings: ${String(result.embeddings ?? 'included')}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `KV-Cache backup error: ${msg}` }] };
      }
    },
  );
}

function _registerKVRestore(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_restore',
    'Restore KV-Cache data from a backup DB.',
    {
      project: z.string().describe('Project name'),
      backupId: z.string().optional().describe('Backup ID (default: latest)'),
      target: z.enum(['json', 'sqlite']).optional().describe('Restore target: json (default) or sqlite'),
    },
    async ({ project, backupId, target }: KVRestoreInput) => {
      try {
        const validTargets = ['json', 'sqlite'] as const;
        type RestoreTarget = typeof validTargets[number];
        const safeTarget: RestoreTarget | undefined = validTargets.includes(target as RestoreTarget) ? target as RestoreTarget : undefined;
        const result = await kvCache.restore(project, backupId, { target: safeTarget });
        if (result.error) return { isError: true, content: [{ type: 'text', text: `KV-Cache restore error: ${result.error}` }] };
        return {
          content: [{
            type: 'text',
            text: `KV-Cache restored from ${result.backupId ?? ''}: ${String(result.restored ?? 0)} snapshots, ${String(result.embeddings ?? 0)} embeddings (target: ${result.target ?? 'json'})`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `KV-Cache restore error: ${msg}` }] };
      }
    },
  );
}

function _registerKVBackupList(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_backup_list',
    'List KV-Cache backup history for a project.',
    {
      project: z.string().describe('Project name'),
    },
    async ({ project }: KVBackupListInput) => {
      try {
        const backups = kvCache.listBackups(project);
        if (backups.length === 0) return { content: [{ type: 'text', text: `No backups for ${project}.` }] };
        const status = kvCache.backupStatus(project);
        const lines = backups.map((b, i) => {
          const bTime = (b.timestamp ?? '').split('T')[0] ?? '';
          return `${i + 1}. [${b.id ?? ''}] ${b.type ?? ''} | ${b.sizeFormatted ?? ''} | ${bTime}`;
        });
        return {
          content: [{
            type: 'text',
            text: `KV-Cache backups for ${project}: ${String(status.totalBackups ?? 0)} total (${status.totalBackupSize ?? ''})\nLast: ${status.lastBackup ?? 'never'}\n\n${lines.join('\n')}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache backup list error: ${msg}` }] };
      }
    },
  );
}

