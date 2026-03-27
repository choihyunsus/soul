// Soul KV-Cache v9.0 — MCP tool registration. Exposes KV-Cache to agents.
import type { z as ZodType } from 'zod';
import { SoulKVCache } from '../lib/kv-cache';
import type { McpToolServer, SoulConfig } from '../types';

interface KVSaveInput {
  agent: string;
  project: string;
  summary: string;
  decisions?: string[];
  todo?: string[];
  filesCreated?: Array<{ path: string; desc: string }>;
  filesModified?: Array<{ path: string; desc: string }>;
}

interface KVLoadInput {
  project: string;
  budget?: number;
  level?: string;
}

interface KVSearchInput {
  query: string;
  project: string;
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

// Backup types imported from ../lib/kv-cache/backup — no local duplicates needed

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
    'Save current session as a KV-Cache snapshot. Auto-called at n2_work_end if enabled.',
    {
      agent: z.string().describe('Agent name'),
      project: z.string().describe('Project name'),
      summary: z.string().describe('Session summary'),
      decisions: z.array(z.string()).optional().describe('Key decisions made'),
      todo: z.array(z.string()).optional().describe('TODO items for next session'),
      filesCreated: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files created'),
      filesModified: z.array(z.object({ path: z.string(), desc: z.string() })).optional().describe('Files modified'),
    },
    async ({ agent, project, summary, decisions, todo, filesCreated, filesModified }: KVSaveInput) => {
      try {
        const id = await kvCache.save(agent, project, {
          summary, decisions: decisions ?? [], todo: todo ?? [],
          filesCreated: filesCreated ?? [], filesModified: filesModified ?? [],
        });
        const snapCount = (await kvCache.listSnapshots(project)).length;
        return { content: [{ type: 'text', text: `KV-Cache saved: ${id} (${snapCount} total for ${project})` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache save error: ${msg}` }] };
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
      budget: z.number().optional().describe('Token budget for context (default: 2000)'),
      level: z.string().optional().describe('Progressive level: L1 (minimal), L2 (standard), L3 (full), auto (default)'),
    },
    async ({ project, budget, level }: KVLoadInput) => {
      try {
        const snap = await kvCache.load(project, { budget, level: level ?? 'auto' });
        if (!snap) return { content: [{ type: 'text', text: `No KV-Cache snapshots found for ${project}.` }] };
        const header = `[${snap._level ?? 'auto'} | ~${snap._promptTokens ?? '?'} tokens]`;
        return { content: [{ type: 'text', text: `${header}\n${snap._resumePrompt ?? `Snapshot ${snap.id} loaded.`}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache load error: ${msg}` }] };
      }
    },
  );
}

function _registerKVSearch(server: McpToolServer, z: typeof ZodType, kvCache: SoulKVCache): void {
  server.tool(
    'n2_kv_search',
    'Search across KV-Cache snapshots for relevant past sessions.',
    {
      query: z.string().describe('Search query (keywords, space-separated)'),
      project: z.string().describe('Project name'),
      maxResults: z.number().optional().describe('Max results (default: 5)'),
    },
    async ({ query, project, maxResults }: KVSearchInput) => {
      try {
        const results = await kvCache.search(query, project, maxResults ?? 5);
        if (results.length === 0) return { content: [{ type: 'text', text: `No KV-Cache results for "${query}" in ${project}.` }] };
        const lines = results.map((r, i) => {
          const date = (r.endedAt ?? r.startedAt ?? '').split('T')[0] ?? '';
          return `${i + 1}. [${date}] ${r.agentName} | ${r.keys.slice(0, 5).join(', ')}\n   ${(r.context?.summary ?? '').slice(0, 150)}`;
        });
        return { content: [{ type: 'text', text: `KV-Cache search: "${query}" (${results.length} results)\n\n${lines.join('\n\n')}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache search error: ${msg}` }] };
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
      maxAgeDays: z.number().optional().describe('Delete older than N days'),
    },
    async ({ project, maxAgeDays }: KVGcInput) => {
      try {
        const result = await kvCache.gc(project, maxAgeDays);
        const remaining = (await kvCache.listSnapshots(project)).length;
        return { content: [{ type: 'text', text: `KV-Cache GC: ${result.deleted} deleted, ${remaining} remaining for ${project}.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache GC error: ${msg}` }] };
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
        return { content: [{ type: 'text', text: `KV-Cache backup error: ${msg}` }] };
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
      target: z.string().optional().describe('Restore target: json (default) or sqlite'),
    },
    async ({ project, backupId, target }: KVRestoreInput) => {
      try {
        const validTargets = ['json', 'sqlite'] as const;
        type RestoreTarget = typeof validTargets[number];
        const safeTarget: RestoreTarget | undefined = validTargets.includes(target as RestoreTarget) ? target as RestoreTarget : undefined;
        const result = await kvCache.restore(project, backupId, { target: safeTarget });
        if (result.error) return { content: [{ type: 'text', text: `KV-Cache restore error: ${result.error}` }] };
        return {
          content: [{
            type: 'text',
            text: `KV-Cache restored from ${result.backupId ?? ''}: ${String(result.restored ?? 0)} snapshots, ${String(result.embeddings ?? 0)} embeddings (target: ${result.target ?? 'json'})`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache restore error: ${msg}` }] };
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

