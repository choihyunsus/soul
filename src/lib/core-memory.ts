// Soul v9.0 - Core Memory: agent-specific facts, auto-injected at boot.
import fs from 'fs';
import path from 'path';
import { writeJson, nowISO } from './utils';

import { createHash } from 'crypto';
import { canonicalAgent } from './continuity';
import { memorySegment } from './kv-cache/atomic-json';
import { readStrict, acquireLock } from './durable';

interface CoreMemoryFile {
  agent: string;
  memory: Record<string, string>;
  updatedAt: string;
}

/**
 * CoreMemory - Agent-specific always-loaded memory.
 * Automatically included in context at boot.
 * Data path: data/memory/core-memory/{agent}.json
 */
export class CoreMemory {
  private readonly dir: string;
  private _cache: Record<string, CoreMemoryFile>;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'memory', 'core-memory');
    this._cache = {};
  }

  /** Agent core memory file path */
  private _filePath(agentName: string): string {
    const name = memorySegment(canonicalAgent(agentName));
    const legacy = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (legacy && legacy !== name) {
      const candidate = path.join(this.dir, legacy + '.json');
      const data = readStrict<CoreMemoryFile>(candidate);
      if (data && canonicalAgent(data.agent) === name) return candidate;
    }
    const safeName = /^[a-z0-9_-]+$/.test(name) ? name : 'unicode-' + createHash('sha256').update(name).digest('hex');
    return path.join(this.dir, `${safeName}.json`);
  }

  /** Load agent core memory */
  read(agentName: string): CoreMemoryFile {
    agentName = canonicalAgent(agentName);
    const data = readStrict<CoreMemoryFile>(this._filePath(agentName));
    if (data && (canonicalAgent(data.agent) !== agentName || !data.memory || typeof data.memory !== 'object' || Array.isArray(data.memory))) throw new Error('Core memory identity/schema mismatch; original file preserved');
    const result = data || { agent: agentName, memory: {}, updatedAt: nowISO() };
    this._cache[agentName] = result;
    return result;
  }

  /** Write key-value to core memory */
  write(agentName: string, key: string, value: string): { action: string } {
    const release = acquireLock(this._filePath(agentName) + '.lock');
    try {
    const data = this.read(agentName);
    const action = data.memory[key] ? 'updated' : 'created';
    Object.defineProperty(data.memory, key, { value, writable: true, enumerable: true, configurable: true });
    data.updatedAt = nowISO();
    this._cache[agentName] = data;

    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    writeJson(this._filePath(agentName), data);
    return { action };
    } finally { release(); }
  }

  /** Remove key from core memory */
  remove(agentName: string, key: string): boolean {
    const release = acquireLock(this._filePath(agentName) + '.lock');
    try {
    const data = this.read(agentName);
    if (!(key in data.memory)) return false;
    delete data.memory[key];
    data.updatedAt = nowISO();
    this._cache[agentName] = data;
    writeJson(this._filePath(agentName), data);
    return true;
    } finally { release(); }
  }

  /** List all keys for an agent */
  keys(agentName: string): string[] {
    const data = this.read(agentName);
    return Object.keys(data.memory);
  }

  /** Generate prompt text for boot injection */
  toPrompt(agentName: string, maxTokens: number = 500): string {
    const data = this.read(agentName);
    const entries = Object.entries(data.memory);
    if (entries.length === 0) return '';

    const lines = entries.map(([k, v]) => `${k}: ${v}`);
    let result = lines.join(' | ');

    // Rough char-based token limit
    if (result.length > maxTokens * 2) {
      result = result.slice(0, maxTokens * 2) + '...';
    }

    return `Core[${agentName}]: ${result}`;
  }

  /** Summary of all agents' core memories */
  toContextAll(): string {
    if (!fs.existsSync(this.dir)) return '';
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return '';

    const summaries: string[] = [];
    for (const f of files) {
      const agent = readStrict<CoreMemoryFile>(path.join(this.dir, f))?.agent;
      if (!agent) continue;
      const prompt = this.toPrompt(agent, 200);
      if (prompt) summaries.push(prompt);
    }
    return summaries.join('\n');
  }

  /** Invalidate cache */
  invalidateCache(): void {
    this._cache = {};
  }
}
