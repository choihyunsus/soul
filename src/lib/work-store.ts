// Durable work identities; never infer ownership from a shared project slot.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { canonicalAgent } from './continuity';
import { memorySegment } from './kv-cache/atomic-json';
import { acquireLock, readStrict } from './durable';
import { writeJson, nowISO } from './utils';
import type { FileChange } from '../types';

export interface WorkRecord {
  id: string; agent: string; project: string; task: string; startedAt: string;
  filesCreated: FileChange[]; filesModified: FileChange[]; filesDeleted: FileChange[]; decisions: string[];
  ending?: string; completed?: boolean;
  learningStatus?: 'pending' | 'saved' | 'failed';
  ledger?: { id: string; path: string };
}

export class WorkStore {
  constructor(private dataDir: string) {}
  private dir(project: string): string { return path.join(this.dataDir, 'work-sessions', memorySegment(project)); }
  lock(project: string): () => void { return acquireLock(path.join(this.dir(project), 'project.lock')); }
  save(record: WorkRecord): void {
    writeJson(path.join(this.dir(record.project), memorySegment(record.id) + '.json'), record);
  }
  start(project: string, agent: string, task: string): WorkRecord {
    const record: WorkRecord = { id: randomUUID(), project: memorySegment(project), agent: memorySegment(canonicalAgent(agent)),
      task, startedAt: nowISO(), filesCreated: [], filesModified: [], filesDeleted: [], decisions: [] };
    this.save(record);
    return record;
  }
  resolve(project: string, agent?: string, id?: string): WorkRecord {
    const dir = this.dir(project);
    const names = id ? [memorySegment(id) + '.json'] : fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
    const records = names.map(n => readStrict<WorkRecord>(path.join(dir, n)))
      .filter((r): r is WorkRecord => !!r && r.project === project && (!agent || r.agent === canonicalAgent(agent)) && (!!id || !r.completed));
    if (records.length !== 1) throw new Error('Specify the sessionId returned by n2_work_start; missing or ambiguous work session');
    const record = records[0];
    if (!record) throw new Error('Work session was not found');
    return record;
  }
  pending(project?: string): WorkRecord[] {
    const base = path.join(this.dataDir, 'work-sessions');
    const projects = project ? [memorySegment(project)] : fs.existsSync(base) ? fs.readdirSync(base) : [];
    return projects.flatMap(name => {
      const dir = this.dir(name);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readStrict<WorkRecord>(path.join(dir, n)))
        .filter((r): r is WorkRecord => !!r && (!r.completed || r.learningStatus === 'pending' || r.learningStatus === 'failed'));
    });
  }
  active(project: string, agent: string): WorkRecord[] {
    const dir = this.dir(project);
    return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(n => n.endsWith('.json'))
      .map(n => readStrict<WorkRecord>(path.join(dir, n)))
      .filter((r): r is WorkRecord => !!r && !r.completed && r.agent === canonicalAgent(agent));
  }
}
