// Soul v9.0 — Centralized conversation log writer for inter-agent communication.
import fs from 'fs';
import path from 'path';
import { detectAgentsDir } from './agent-registry';
import { writeJson, readJson, nowISO, logError } from './utils';
import type { SoulConfig } from '../types';

// ── Types ──

interface ConversationEntry {
  timestamp: string;
  type: 'call' | 'called';
  caller: string;
  target: string;
  provider: string;
  model: string;
  message: string;
  response: string;
  usage: Record<string, unknown> | null;
}

interface LLMResponse {
  content?: string;
  usage?: Record<string, unknown>;
}

interface ProviderMeta {
  provider?: string;
  model?: string;
}

interface TargetConfig {
  name?: string;
}

// ── Agent name whitelist (lazy-loaded from agent configs) ──

let _validNames: Set<string> | null = null;

/** Load valid agent names from agent config files */
export function getValidAgentNames(): Set<string> {
  if (_validNames) return _validNames;
  _validNames = new Set(['master', 'owner']);
  try {
    const agentsDir = detectAgentsDir();
    if (agentsDir && fs.existsSync(agentsDir)) {
      const files = fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.json') && f !== 'global.json');
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(agentsDir, f), 'utf-8');
          const cfg = JSON.parse(raw) as { name?: string; enabled?: boolean };
          if (cfg.name && cfg.enabled !== false) _validNames.add(cfg.name);
        } catch (e) {
          logError('intercom:parse-config', `${f}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) { logError('intercom:agents-dir', e); }
  return _validNames;
}

/** Normalize a sender/caller name to a valid agent name */
export function normalizeName(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return 'master';
  const valid = getValidAgentNames();
  if (valid.has(name)) return name;
  for (const v of valid) {
    if (v.toLowerCase() === name.toLowerCase()) return v;
  }
  return 'master';
}

// ── Path helpers ──

function getConversationsDir(config: Partial<SoulConfig> | null): string {
  const dataDir = config?.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'conversations');
}

function getAgentLogDir(
  config: Partial<SoulConfig> | null, agentName: string, date?: string,
): string {
  const dateParts = (date || nowISO().split('T')[0] || '').split('-');
  const y = dateParts[0] || '0000';
  const m = dateParts[1] || '00';
  const d = dateParts[2] || '00';
  return path.join(getConversationsDir(config), agentName, y, m, d);
}

/** Get next sequential log ID (max existing + 1) */
export function getNextLogId(dir: string): string {
  if (!fs.existsSync(dir)) return '001';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const nums = files.map(f => parseInt(f.split('.')[0] || '0') || 0);
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return String(max + 1).padStart(3, '0');
}

// ── Core write function ──

/** Write a conversation log entry for both caller and target */
export function writeConversationLog(
  config: Partial<SoulConfig> | null,
  caller: string,
  target: string | TargetConfig,
  message: string,
  response: LLMResponse,
  meta: ProviderMeta,
): { callerLog: string; targetLog: string } | null {
  const safeCaller = normalizeName(caller);
  const targetName = typeof target === 'object' ? (target.name || String(target)) : target;
  const safeTarget = normalizeName(targetName);

  const date = nowISO().split('T')[0];
  const entry: ConversationEntry = {
    timestamp: nowISO(),
    type: 'call',
    caller: safeCaller,
    target: safeTarget,
    provider: meta?.provider || 'unknown',
    model: meta?.model || 'unknown',
    message: typeof message === 'string' ? message : '',
    response: response?.content || '',
    usage: response?.usage || null,
  };

  const callerDir = getAgentLogDir(config, safeCaller, date);
  const callerId = getNextLogId(callerDir);
  writeJson(path.join(callerDir, `${callerId}.json`), entry);

  const targetDir = getAgentLogDir(config, safeTarget, date);
  const targetId = getNextLogId(targetDir);
  writeJson(path.join(targetDir, `${targetId}.json`), { ...entry, type: 'called' as const });

  // Signal file for live detection (best-effort)
  try {
    const signalPath = path.join(getConversationsDir(config), '..', 'intercom-signal.json');
    const tmpPath = signalPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    fs.renameSync(tmpPath, signalPath);
  } catch (e) { logError('intercom:signal', e); }

  return { callerLog: `${safeCaller}/${callerId}`, targetLog: `${safeTarget}/${targetId}` };
}

// ── Read functions ──

/** Read conversation logs for an agent on a specific date */
export function readConversationLogs(
  config: Partial<SoulConfig> | null,
  agentName: string,
  date: string,
  lastN?: number,
): ConversationEntry[] {
  const dir = getAgentLogDir(config, agentName, date);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-(lastN || 50));
  return files
    .map(f => readJson<ConversationEntry>(path.join(dir, f)))
    .filter((e): e is ConversationEntry => e !== null);
}

/** Get recent conversation dates for an agent */
export function getConversationDates(
  config: Partial<SoulConfig> | null,
  agentName: string,
  limit?: number,
): string[] {
  const baseDir = path.join(getConversationsDir(config), agentName);
  if (!fs.existsSync(baseDir)) return [];
  const dates: string[] = [];
  try {
    const years = fs.readdirSync(baseDir).filter(f => /^\d{4}$/.test(f)).sort().reverse();
    for (const y of years) {
      const months = fs.readdirSync(path.join(baseDir, y))
        .filter(f => /^\d{2}$/.test(f)).sort().reverse();
      for (const m of months) {
        const days = fs.readdirSync(path.join(baseDir, y, m))
          .filter(f => /^\d{2}$/.test(f)).sort().reverse();
        for (const d of days) {
          dates.push(`${y}-${m}-${d}`);
          if (dates.length >= (limit || 7)) return dates;
        }
      }
    }
  } catch (e) { logError('intercom:dates', e); }
  return dates;
}

/** Invalidate cached agent names (call after agent config changes) */
export function resetNameCache(): void {
  _validNames = null;
}
