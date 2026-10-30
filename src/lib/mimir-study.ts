// Durable, scoped study collection. Web similarity and study entries are not verified lessons.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { openMimir, learningIdentity } from './mimir-db';
import { memorySegment } from './kv-cache/atomic-json';
import { redactMemory } from './recall';
import { recordWorkReports } from './mimir-scope';
import type { WorkReport } from './mimir-scope';
import type { Scope } from './mimir-learning';

export interface StudyEntry { entryId: string; action: string; outcome: string; sourceRef: string; type?: string }
interface Study { id: string; project: string; agent: string; topic: string; source: string; status: string; entries: string; frozen: string | null; request_id: string; }
const SCHEMA = `CREATE TABLE IF NOT EXISTS soul_mimir_studies (
 id TEXT PRIMARY KEY, project TEXT NOT NULL, agent TEXT NOT NULL, topic TEXT NOT NULL, source TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('collecting','ending','completed')), entries TEXT NOT NULL, frozen TEXT,
 request_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project,agent,request_id));`;
const checkText = (value: string, label: string, max = 8000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid study ' + label);
  return redactMemory(value.trim());
};

export class StudyStore {
  constructor(private dataDir: string) {}
  private write<T>(scope: Scope, action: (db: Database.Database, scope: Scope) => T): T {
    scope = { project: scope.project, agent: learningIdentity(scope.project, scope.agent) };
    const db = openMimir(this.dataDir, true);
    try { db.exec(SCHEMA); return db.transaction(() => action(db, scope)).immediate(); }
    finally { db.close(); }
  }
  private row(db: Database.Database, scope: Scope, id: string): Study {
    memorySegment(id);
    const result = db.prepare('SELECT * FROM soul_mimir_studies WHERE id=? AND project=? AND agent=?').get(id, scope.project, scope.agent) as Study | undefined;
    if (!result) throw Error('Study session not found in requested scope');
    return result;
  }
  start(scope: Scope, requestId: string, topic: string, source: string): { sessionId: string; status: string; storedEntries: number } {
    memorySegment(requestId); topic = checkText(topic, 'topic', 500); source = checkText(source, 'source', 1000);
    return this.write(scope, (db, owner) => {
      const old = db.prepare('SELECT * FROM soul_mimir_studies WHERE project=? AND agent=? AND request_id=?').get(owner.project, owner.agent, requestId) as Study | undefined;
      if (old) { if (old.topic !== topic || old.source !== source) throw Error('Study start retry changed'); return { sessionId: old.id, status: old.status, storedEntries: (JSON.parse(old.entries) as StudyEntry[]).length }; }
      const id = randomUUID();
      db.prepare("INSERT INTO soul_mimir_studies VALUES (?,?,?,?,?,'collecting','[]',NULL,?,?)").run(id, owner.project, owner.agent, topic, source, requestId, new Date().toISOString());
      return { sessionId: id, status: 'collecting', storedEntries: 0 };
    });
  }
  add(scope: Scope, sessionId: string, entries: StudyEntry[]): { stored: number } {
    if (entries.length > 100) throw Error('Study entry batch exceeds limit');
    const clean = entries.map(e => ({ entryId: memorySegment(e.entryId), action: checkText(e.action, 'action'), outcome: checkText(e.outcome, 'outcome'), sourceRef: checkText(e.sourceRef, 'source reference', 2000), type: checkText(e.type || 'pattern', 'reported type', 50) }));
    return this.write(scope, (db, owner) => {
      const row = this.row(db, owner, sessionId);
      if (row.status !== 'collecting') throw Error('Study has frozen for completion; no entries may change');
      const saved = JSON.parse(row.entries) as StudyEntry[];
      for (const entry of clean) {
        const prior = saved.find(e => e.entryId === entry.entryId);
        if (prior) { if (JSON.stringify(prior) !== JSON.stringify(entry)) throw Error('Study entry retry changed; original preserved'); }
        else saved.push(entry);
      }
      const serialized = JSON.stringify(saved);
      if (saved.length > 100 || Buffer.byteLength(serialized) > 384 * 1024) throw Error('Study session exceeds limit');
      db.prepare('UPDATE soul_mimir_studies SET entries=? WHERE id=?').run(serialized, row.id);
      return { stored: saved.length };
    });
  }
  end(scope: Scope, sessionId: string): { sessionId: string; status: string; experienceIds: string[] } {
    const frozen = this.write(scope, (db, owner) => {
      const row = this.row(db, owner, sessionId);
      if (row.status === 'completed') return null;
      if (row.frozen) return JSON.parse(row.frozen) as WorkReport;
      const entries = JSON.parse(row.entries) as StudyEntry[];
      const report: WorkReport = { sourceKind: 'study', sessionId: row.id,
        summary: JSON.stringify({ topic: row.topic, source: row.source, status: 'Unverified study collection; not applied knowledge' }),
        decisions: entries.map(e => JSON.stringify({ source: e.sourceRef, action: e.action, reportedOutcome: e.outcome, reportedType: e.type, entryId: e.entryId })) };
      db.prepare("UPDATE soul_mimir_studies SET status='ending',frozen=? WHERE id=?").run(JSON.stringify(report), row.id);
      return report;
    });
    if (frozen) recordWorkReports(this.dataDir, scope.project, scope.agent, frozen);
    return this.write(scope, (db, owner) => {
      const row = this.row(db, owner, sessionId);
      db.prepare("UPDATE soul_mimir_studies SET status='completed' WHERE id=?").run(row.id);
      const ids = db.prepare('SELECT id FROM experiences WHERE project=? AND agent=? AND session_id=? ORDER BY id').all(owner.project, owner.agent, row.id) as Array<{ id: string }>;
      return { sessionId: row.id, status: 'completed', experienceIds: ids.map(e => e.id) };
    });
  }
  list(scope: Scope): unknown[] {
    scope = { project: scope.project, agent: learningIdentity(scope.project, scope.agent) };
    if (!fs.existsSync(path.join(this.dataDir, 'mimir.db'))) return [];
    const db = openMimir(this.dataDir);
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='soul_mimir_studies'").get()) return [];
      return db.prepare("SELECT id,topic,source,status,created_at FROM soul_mimir_studies WHERE project=? AND agent=? AND status<>'completed' ORDER BY created_at LIMIT 50").all(scope.project, scope.agent);
    } finally { db.close(); }
  }
}
