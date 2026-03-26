// Soul v9.0 — Core Memory: agent-specific facts, auto-injected at boot.
import fs from 'fs';
import path from 'path';
import { readJson, writeJson, nowISO } from './utils';

interface CoreMemoryFile {
  agent: string;
  memory: Record<string, string>;
  updatedAt: string;
}

/**
 * CoreMemory — Agent-specific always-loaded memory.
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
    const safeName = agentName.toLowerCase().replace(/[^a-z0-9\-_]/g, '');
    return path.join(this.dir, `${safeName}.json`);
  }

  /** Load agent core memory */
  read(agentName: string): CoreMemoryFile {
    const cached = this._cache[agentName];
    if (cached) return cached;
    const data = readJson<CoreMemoryFile>(this._filePath(agentName));
    const result = data || { agent: agentName, memory: {}, updatedAt: nowISO() };
    this._cache[agentName] = result;
    return result;
  }

  /** Write key-value to core memory */
  write(agentName: string, key: string, value: string): { action: string } {
    const data = this.read(agentName);
    const action = data.memory[key] ? 'updated' : 'created';
    data.memory[key] = value;
    data.updatedAt = nowISO();
    this._cache[agentName] = data;

    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    writeJson(this._filePath(agentName), data);
    return { action };
  }

  /** Remove key from core memory */
  remove(agentName: string, key: string): boolean {
    const data = this.read(agentName);
    if (!(key in data.memory)) return false;
    delete data.memory[key];
    data.updatedAt = nowISO();
    this._cache[agentName] = data;
    writeJson(this._filePath(agentName), data);
    return true;
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
      const agent = f.replace('.json', '');
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
