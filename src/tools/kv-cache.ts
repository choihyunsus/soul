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

export function registerKVCacheTools(
  server: McpToolServer,
  z: typeof ZodType,
  config: SoulConfig,
): void {
  if (!config.KV_CACHE?.enabled) return;

  const kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);

  // n2_kv_save
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
          summary,
          decisions: decisions ?? [],
          todo: todo ?? [],
          filesCreated: filesCreated ?? [],
          filesModified: filesModified ?? [],
        });
        const snapCount = (await kvCache.listSnapshots(project)).length;
        return { content: [{ type: 'text', text: `KV-Cache saved: ${id} (${snapCount} total for ${project})` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache save error: ${msg}` }] };
      }
    },
  );

  // n2_kv_load
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
        if (!snap) {
          return { content: [{ type: 'text', text: `No KV-Cache snapshots found for ${project}.` }] };
        }
        const header = `[${snap._level ?? 'auto'} | ~${snap._promptTokens ?? '?'} tokens]`;
        return { content: [{ type: 'text', text: `${header}\n${snap._resumePrompt ?? `Snapshot ${snap.id} loaded.`}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache load error: ${msg}` }] };
      }
    },
  );

  // n2_kv_search
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
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No KV-Cache results for "${query}" in ${project}.` }] };
        }
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

  // n2_kv_gc
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

  // n2_kv_backup
  server.tool(
    'n2_kv_backup',
    'Backup KV-Cache data to a portable SQLite DB. Supports incremental backups.',
    {
      project: z.string().describe('Project name'),
      full: z.boolean().optional().describe('Force full backup (ignore incremental)'),
    },
    async ({ project, full }: KVBackupInput) => {
      try {
        const result = await kvCache.backup(project, { full }) as Record<string, unknown>;
        if (result['type'] === 'skip') {
          return { content: [{ type: 'text', text: `KV-Cache backup skipped: ${String(result['message'] ?? '')}` }] };
        }
        if (result['type'] === 'empty') {
          return { content: [{ type: 'text', text: `KV-Cache backup: no data for ${project}.` }] };
        }
        return {
          content: [{
            type: 'text',
            text: `KV-Cache backup created: ${String(result['backupId'] ?? '')}\nType: ${String(result['type'])} | Size: ${String(result['sizeFormatted'] ?? '')}\nSnapshots: ${String(result['snapshots'] ?? 'copied')} | Embeddings: ${String(result['embeddings'] ?? 'included')}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache backup error: ${msg}` }] };
      }
    },
  );

  // n2_kv_restore
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
        const result = await kvCache.restore(project, backupId, { target: target as 'json' | 'sqlite' | undefined }) as Record<string, unknown>;
        if (result['error']) {
          return { content: [{ type: 'text', text: `KV-Cache restore error: ${String(result['error'])}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: `KV-Cache restored from ${String(result['backupId'] ?? '')}: ${String(result['restored'])} snapshots, ${String(result['embeddings'] ?? 0)} embeddings (target: ${String(result['target'])})`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache restore error: ${msg}` }] };
      }
    },
  );

  // n2_kv_backup_list
  server.tool(
    'n2_kv_backup_list',
    'List KV-Cache backup history for a project.',
    {
      project: z.string().describe('Project name'),
    },
    async ({ project }: KVBackupListInput) => {
      try {
        const backups = kvCache.listBackups(project) as Array<Record<string, unknown>>;
        if (backups.length === 0) {
          return { content: [{ type: 'text', text: `No backups for ${project}.` }] };
        }
        const status = kvCache.backupStatus(project) as Record<string, unknown>;
        const lines = backups.map((b, i) =>
          `${i + 1}. [${String(b['id'] ?? '')}] ${String(b['type'] ?? '')} | ${String(b['sizeFormatted'] ?? '')} | ${String(b['timestamp'] ?? '').split('T')[0] ?? ''}`,
        );
        return {
          content: [{
            type: 'text',
            text: `KV-Cache backups for ${project}: ${String(status['totalBackups'])} total (${String(status['totalBackupSize'])})\nLast: ${String(status['lastBackup'] ?? 'never')}\n\n${lines.join('\n')}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `KV-Cache backup list error: ${msg}` }] };
      }
    },
  );
}
