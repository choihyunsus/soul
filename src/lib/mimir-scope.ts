// Scoped access to the existing Mimir schema. Reading never votes, learns, or creates rules.
import { SCHEMA_SQL } from './mimir-schema';
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { canonicalAgent } from './continuity';
import { memorySegment } from './kv-cache/atomic-json';
import { redactMemory } from './recall';
export { scopedMimirContext, scopedMimirRecall } from './mimir-recall';

type Row = Record<string, unknown>;
interface Statement {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
  run(...params: unknown[]): { changes: number };
}
interface Connection { prepare(sql: string): Statement; exec(sql: string): void; close(): void }
const Database = require('better-sqlite3') as new (file: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }) => Connection;

export interface WorkReport {
  sessionId: string; summary?: string; decisions?: string[];
  sourceKind?: 'work' | 'study';
  filesCreated?: Array<{ path: string; desc: string }>;
  filesModified?: Array<{ path: string; desc: string }>;
}
interface Report { source: string; action: string; type: 'pattern' | 'correction'; correction: string | null }

function identity(project: string, agent: string): string {
  memorySegment(project);
  return memorySegment(canonicalAgent(agent));
}

function reports(input: WorkReport): Report[] {
  memorySegment(input.sessionId);
  if (input.sourceKind && !['work', 'study'].includes(input.sourceKind)) throw Error('Invalid report source kind');
  const output: Report[] = [];
  const add = (source: string, text: string) => {
    if (!text.trim()) return;
    if (text.length > 32000) throw Error('Mimir report exceeds 32000 characters; keep the full source in the checkpoint');
    const action = redactMemory(text);
    // Only an explicit marker labels a user correction. Ordinary fix/error words are not evidence.
    const correction = /^(?:사용자\s*교정|user\s+correction)\s*[:：]\s*(\S[\s\S]*)$/i.exec(action)?.[1] || null;
    output.push({ source, action, type: correction ? 'correction' : 'pattern', correction });
  };
  add('summary', input.summary || '');
  (input.decisions || []).forEach((text, i) => add(`decision/${i}`, text));
  for (const kind of ['filesCreated', 'filesModified'] as const) {
    (input[kind] || []).forEach((file, i) => add(`${kind}/${i}`, JSON.stringify({ path: file.path, reportedChange: file.desc })));
  }
  if (output.length > 200 || Buffer.byteLength(JSON.stringify(output)) > 512 * 1024) throw Error('Mimir report batch exceeds limit');
  return output;
}

/** Append reports once per work/session/source. Never infer successful execution or reinforcement. */
export function recordWorkReports(dataDir: string, project: string, agent: string, input: WorkReport): { inserted: number; duplicates: number } {
  agent = identity(project, agent);
  const entries = reports(input);
  if (!entries.length) return { inserted: 0, duplicates: 0 };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mimir.db');
  const exists = fs.existsSync(file);
  const db = new Database(file, { timeout: 1500 });
  try {
    if (!exists) db.exec(SCHEMA_SQL);
    db.exec('PRAGMA foreign_keys=ON');
    // Additive receipts; historical experiences and insights are never rewritten.
    db.exec(`CREATE TABLE IF NOT EXISTS soul_mimir_ingest (
      source_ref TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
      experience_id TEXT NOT NULL REFERENCES experiences(id), created_at TEXT NOT NULL)`);
    db.exec('BEGIN IMMEDIATE');
    let inserted = 0, duplicates = 0;
    try {
      for (const entry of entries) {
        const source = `soul-${input.sourceKind || 'work'}://` + [project, agent, input.sessionId, entry.source].map(encodeURIComponent).join('/');
        const digest = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
        const prior = db.prepare('SELECT payload_hash FROM soul_mimir_ingest WHERE source_ref=?').get(source);
        if (prior) {
          if (prior.payload_hash !== digest) throw Error('Mimir report retry differs from its saved source; original preserved');
          duplicates++; continue;
        }
        const id = randomUUID(), now = new Date().toISOString();
        db.prepare(`INSERT INTO experiences
          (id,session_id,agent,project,type,category,severity,context,action,outcome,correction,source_ref,frequency,token_cost,created_at)
          VALUES (?,?,?,?,?,'workflow','info',?,?,?,?,?,1,?,?)`).run(
          id, input.sessionId, agent, project, entry.type,
          `Source: durable ${input.sourceKind || 'work'} report. Reported content, not independently verified evidence.`, entry.action,
          entry.correction ? 'User correction reported; application and effect not verified.' : 'Report recorded; execution outcome not inferred.',
          entry.correction, source, Math.ceil(Buffer.byteLength(entry.action) / 3), now);
        db.prepare('INSERT INTO soul_mimir_ingest VALUES (?,?,?,?)').run(source, digest, id, now);
        inserted++;
      }
      db.exec('COMMIT');
      return { inserted, duplicates };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
