// Soul v9.0 — Dynamic agent registry. Detects agents from N2 Browser config.
import fs from 'fs';
import path from 'path';
import { logError, readJson } from './utils';
import { getAgentsDir } from './paths';

export interface AgentInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  soul: string;
  rank: string;
  enabled: boolean;
}

interface AgentFileData {
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
  soul?: string;
  rank?: string;
  enabled?: boolean;
}

/** Detect agents directory dynamically (project-local first, cross-platform) */
export function detectAgentsDir(): string | null {
  const candidates: (string | undefined)[] = [
    process.env.N2_AGENTS_DIR,
    getAgentsDir(),
    path.join(process.cwd(), '_data', 'agents'),
  ];

  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) return dir;
  }
  return null;
}

/** List all registered agents from the agents directory */
export function listAgents(agentsDir: string | null): AgentInfo[] {
  if (!agentsDir || !fs.existsSync(agentsDir)) return [];
  try {
    return fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.json') && f !== 'global.json')
      .map((f): AgentInfo | null => {
        const data = readJson<AgentFileData>(path.join(agentsDir, f));
        if (!data) return null;
        return {
          id: data.id || path.basename(f, '.json'),
          name: data.name || 'unknown',
          provider: data.provider || 'unknown',
          model: data.model || 'unknown',
          soul: data.soul || '',
          rank: data.rank || '?',
          enabled: data.enabled !== false,
        };
      })
      .filter((a): a is AgentInfo => a !== null && a.enabled);
  } catch (e) {
    logError('listAgents', e);
    return [];
  }
}

/** Find agent by name (case-insensitive) */
export function findAgent(agentsDir: string | null, name: string): AgentInfo | null {
  const agents = listAgents(agentsDir);
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase()) || null;
}

/** Read global config */
export function readGlobalConfig(agentsDir: string | null): Record<string, unknown> | null {
  if (!agentsDir) return null;
  return readJson<Record<string, unknown>>(path.join(agentsDir, 'global.json'));
}
