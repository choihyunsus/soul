// Evidence-backed lesson lifecycle. No executable rule generation or automatic voting.
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { openMimir, learningIdentity, ownerSql } from './mimir-db';
import { memorySegment } from './kv-cache/atomic-json';
import { canonicalAgent } from './continuity';
import { redactMemory } from './recall';
import { WorkStore } from './work-store';

type Row = Record<string, unknown>;
type State = 'candidate' | 'verified' | 'held' | 'retired' | 'superseded';
interface Lesson { id: string; project: string; agent: string; state: State; description: string; source_hash: string; correction_hash: string | null; reason: string; }
interface Evidence { id: string; session_id: string; artifact: string; digest: string; outcome: string; applied: number; }
export interface Scope { project: string; agent: string }
export interface Propose extends Scope { requestId: string; description: string; sourceIds: string[] }
export interface AddEvidence extends Scope { requestId: string; lessonId: string; sessionId: string; artifact: string }
export interface Review extends Scope { requestId: string; lessonId: string; action: 'promote' | 'hold' | 'retire'; reason: string; acknowledgedCorrections?: string[]; supersedes?: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, label: string, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid ${label}`);
  return redactMemory(value.trim());
};
const SCHEMA = `
CREATE TABLE IF NOT EXISTS soul_mimir_lessons (
 id TEXT PRIMARY KEY REFERENCES insights(id), project TEXT NOT NULL, agent TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('candidate','verified','held','retired','superseded')),
 description TEXT NOT NULL, source_hash TEXT NOT NULL, correction_hash TEXT, reason TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS soul_lessons_scope ON soul_mimir_lessons(project,agent,state);
CREATE TABLE IF NOT EXISTS soul_mimir_evidence (
 id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES soul_mimir_lessons(id), session_id TEXT NOT NULL,
 artifact TEXT NOT NULL, digest TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('positive','neutral','negative')),
 applied INTEGER NOT NULL CHECK(applied IN (0,1)), created_at TEXT NOT NULL,
 UNIQUE(lesson_id,session_id));
CREATE TABLE IF NOT EXISTS soul_mimir_reviews (
 operation TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, lesson_id TEXT NOT NULL REFERENCES soul_mimir_lessons(id),
 action TEXT NOT NULL, reason TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
`;

export function hasLessons(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='soul_mimir_lessons'").get();
}

function sources(db: Database.Database, scope: Scope, ids: string[]): Row[] {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw Error('Require 1-20 distinct source experience IDs');
  return [...ids].sort().map(id => {
    memorySegment(id);
    const row = db.prepare(`SELECT id,agent,project,type,context,action,outcome,correction,source_ref,session_id FROM experiences WHERE id=?`).get(id) as Row | undefined;
    if (!row || row.project !== scope.project || canonicalAgent(String(row.agent)) !== scope.agent) throw Error('Missing or out-of-scope source experience');
    return row;
  });
}
function corrections(db: Database.Database, scope: Scope): Row[] {
  const rows = db.prepare(`SELECT id,action,outcome,correction FROM experiences WHERE project=? AND ${ownerSql('agent')}=? AND type='correction' ORDER BY id LIMIT 1001`).all(scope.project, scope.agent) as Row[];
  if (rows.length > 1000) throw Error('Correction review exceeds bounded budget');
  return rows;
}
function lesson(db: Database.Database, scope: Scope, id: string): Lesson {
  memorySegment(id);
  const row = db.prepare('SELECT * FROM soul_mimir_lessons WHERE id=? AND project=? AND agent=?').get(id, scope.project, scope.agent) as Lesson | undefined;
  if (!row) throw Error('Lesson not found in the requested scope');
  return row;
}
function lessonSources(db: Database.Database, row: Lesson): Row[] {
  const insight = db.prepare('SELECT description,compressed,agent FROM insights WHERE id=?').get(row.id) as Row | undefined;
  if (!insight || insight.description !== row.description || (insight.compressed && insight.compressed !== row.description) || canonicalAgent(String(insight.agent)) !== row.agent) throw Error('Lesson content/identity changed outside review');
  const links = db.prepare('SELECT experience_id,relation FROM experience_insight_links WHERE insight_id=? ORDER BY experience_id').all(row.id) as Row[];
  if (links.some(l => l.relation !== 'supports')) throw Error('Contradictory source link requires a new lesson revision');
  const rows = sources(db, row, links.map(l => String(l.experience_id)));
  if (hash(rows) !== row.source_hash) throw Error('Source content changed; propose a new reviewed revision');
  return rows;
}
function readArtifact(dataDir: string, scope: Scope, artifact: string): { digest: string; value: Row } {
  // Artifact paths are relative to one explicit evidence directory, never arbitrary files/URLs.
  if (path.isAbsolute(artifact) || artifact.includes(':') || artifact.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('Invalid evidence artifact path');
  const base = path.join(dataDir, 'evidence', memorySegment(scope.project));
  const root = fs.realpathSync.native(dataDir), file = fs.realpathSync.native(path.join(base, artifact));
  const realBase = fs.realpathSync.native(base);
  const inside = (a: string, b: string) => { const rel = path.relative(b, a); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (path.relative(path.join(root, 'evidence', scope.project), realBase) !== '' || !inside(file, realBase)) throw Error('Evidence path escapes the scoped evidence directory');
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 128 * 1024) throw Error('Evidence artifact must be a bounded regular file');
  const bytes = fs.readFileSync(file), value = JSON.parse(bytes.toString('utf8')) as Row;
  if (value.schema !== 'soul-evidence/v1' || value.project !== scope.project || canonicalAgent(String(value.agent)) !== scope.agent) throw Error('Evidence identity/schema mismatch');
  if (!['positive', 'negative', 'neutral'].includes(String(value.outcome)) || typeof value.applied !== 'boolean') throw Error('Evidence requires an explicit applied flag and outcome');
  text(value.method, 'evidence method'); text(value.observation, 'evidence observation', 16000);
  return { digest: createHash('sha256').update(bytes).digest('hex'), value };
}
function evidenceRows(db: Database.Database, id: string): Evidence[] {
  return db.prepare('SELECT * FROM soul_mimir_evidence WHERE lesson_id=? ORDER BY created_at,id LIMIT 101').all(id) as Evidence[];
}
function validateEvidence(dataDir: string, scope: Scope, id: string, item: Evidence): void {
  const artifact = readArtifact(dataDir, scope, item.artifact);
  if (artifact.digest !== item.digest || artifact.value.lessonId !== id || artifact.value.sessionId !== item.session_id || artifact.value.outcome !== item.outcome || Number(artifact.value.applied) !== item.applied) throw Error('Evidence artifact changed or no longer matches the lesson/work/result');
  const work = new WorkStore(dataDir).resolve(scope.project, scope.agent, item.session_id);
  if (!work.completed) throw Error('Evidence must refer to completed durable work');
}

/** A verified flag alone never suffices after sources, artifacts, or corrections change. */
export function lessonValidity(db: Database.Database, dataDir: string, row: Lesson): string | null {
  try {
    lessonSources(db, row);
    if (row.correction_hash !== hash(corrections(db, row))) return 'new-or-changed-user-correction';
    const evidence = evidenceRows(db, row.id);
    if (evidence.length > 100) return 'evidence-budget-exceeded';
    if (evidence.some(e => e.outcome === 'negative')) return 'negative-application-result';
    const positive = evidence.filter(e => e.applied === 1 && e.outcome === 'positive');
    if (positive.length < 2 || positive.length / evidence.length < 0.8) return 'insufficient-application-evidence';
    for (const item of evidence) validateEvidence(dataDir, row, row.id, item);
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'evidence-unavailable'; }
}

export function managedLessonVisible(db: Database.Database, dataDir: string, id: string): boolean {
  if (!hasLessons(db)) return true; // Legacy items remain labelled historical, never promoted here.
  const row = db.prepare('SELECT * FROM soul_mimir_lessons WHERE id=?').get(id) as Lesson | undefined;
  return !row || (row.state === 'verified' && !lessonValidity(db, dataDir, row));
}

export class LessonStore {
  constructor(private dataDir: string) {}
  private mutate<T>(input: Scope & { requestId: string }, action: string, body: (db: Database.Database, scope: Scope) => { id: string; result: T; reason?: string }): T {
    const scope = { project: input.project, agent: learningIdentity(input.project, input.agent) };
    memorySegment(input.requestId);
    const db = openMimir(this.dataDir, true);
    try {
      db.exec(SCHEMA);
      return db.transaction(() => {
        const operation = JSON.stringify([scope.project, scope.agent, input.requestId]);
        const digest = hash({ action, ...input, agent: scope.agent });
        const prior = db.prepare('SELECT payload_hash,result,lesson_id FROM soul_mimir_reviews WHERE operation=?').get(operation) as Row | undefined;
        if (prior) {
          if (prior.payload_hash !== digest) throw Error('Retry payload changed; previous review preserved');
          const current = lesson(db, scope, String(prior.lesson_id));
          const state = current.state === 'verified' && lessonValidity(db, this.dataDir, current) ? 'needs-review' : current.state;
          return { ...JSON.parse(String(prior.result)), state } as T;
        }
        const output = body(db, scope);
        db.prepare('INSERT INTO soul_mimir_reviews VALUES (?,?,?,?,?,?,?)').run(operation, digest, output.id, action, redactMemory(output.reason || ''), JSON.stringify(output.result), new Date().toISOString());
        return output.result;
      }).immediate();
    } finally { db.close(); }
  }
  propose(input: Propose): { lessonId: string; state: string } {
    const description = text(input.description, 'lesson description');
    return this.mutate(input, 'propose', (db, scope) => {
      const rows = sources(db, scope, input.sourceIds), id = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO insights(id,agent,description,category,scope,status,importance,confidence) VALUES (?,?,?,'workflow','project','dormant',0,0)`).run(id, scope.agent, description);
      for (const source of rows) db.prepare('INSERT INTO experience_insight_links VALUES (?,?,?)').run(source.id, id, 'supports');
      db.prepare('INSERT INTO soul_mimir_lessons VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, scope.project, scope.agent, 'candidate', description, hash(rows), null, 'Awaiting evidence review', now, now);
      return { id, result: { lessonId: id, state: 'candidate' } };
    });
  }
  addEvidence(input: AddEvidence): { lessonId: string; evidenceId: string; state: string } {
    return this.mutate(input, 'evidence', (db, scope) => {
      const row = lesson(db, scope, input.lessonId);
      if (['retired', 'superseded'].includes(row.state)) throw Error('Terminal lesson cannot accept new evidence');
      const artifact = readArtifact(this.dataDir, scope, input.artifact);
      if (artifact.value.lessonId !== row.id || artifact.value.sessionId !== input.sessionId) throw Error('Evidence lesson/work mismatch');
      const item: Evidence = { id: randomUUID(), session_id: memorySegment(input.sessionId), artifact: input.artifact, digest: artifact.digest, outcome: String(artifact.value.outcome), applied: artifact.value.applied ? 1 : 0 };
      validateEvidence(this.dataDir, scope, row.id, item);
      if (evidenceRows(db, row.id).length >= 100) throw Error('Evidence limit reached');
      db.prepare('INSERT INTO soul_mimir_evidence VALUES (?,?,?,?,?,?,?,?)').run(item.id, row.id, item.session_id, item.artifact, item.digest, item.outcome, item.applied, new Date().toISOString());
      const state = item.outcome === 'negative' ? 'held' : row.state === 'verified' ? 'held' : row.state;
      db.prepare('UPDATE soul_mimir_lessons SET state=?,updated_at=? WHERE id=?').run(state, new Date().toISOString(), row.id);
      db.prepare("UPDATE insights SET status='dormant' WHERE id=?").run(row.id);
      return { id: row.id, result: { lessonId: row.id, evidenceId: item.id, state }, reason: 'Application evidence recorded; review required' };
    });
  }
  review(input: Review): { lessonId: string; state: string } {
    const reason = text(input.reason, 'review reason');
    return this.mutate(input, input.action, (db, scope) => {
      const row = lesson(db, scope, input.lessonId);
      if (['retired', 'superseded'].includes(row.state)) throw Error('Terminal lesson requires a new revision');
      let state: State;
      if (input.action === 'promote') {
        const current = corrections(db, scope);
        const acknowledged = [...new Set(input.acknowledgedCorrections || [])].sort();
        if (JSON.stringify(acknowledged) !== JSON.stringify(current.map(r => String(r.id)).sort())) throw Error('Review and acknowledge every current user correction in this scope');
        row.correction_hash = hash(current);
        const invalid = lessonValidity(db, this.dataDir, row);
        if (invalid) throw Error('Lesson promotion blocked: ' + invalid);
        state = 'verified';
        if (input.supersedes) {
          if (input.supersedes === row.id) throw Error('A lesson cannot supersede itself');
          const previous = lesson(db, scope, input.supersedes);
          if (['retired', 'superseded'].includes(previous.state)) throw Error('Previous lesson is already terminal');
          db.prepare("UPDATE soul_mimir_lessons SET state='superseded',reason=?,updated_at=? WHERE id=?").run('Superseded by ' + row.id + ': ' + reason, new Date().toISOString(), previous.id);
          db.prepare("UPDATE insights SET status='retired' WHERE id=?").run(previous.id);
          db.prepare("INSERT INTO insight_links VALUES (?,?,'supersedes')").run(row.id, previous.id);
        }
      } else if (input.action === 'hold' || input.action === 'retire') state = input.action === 'hold' ? 'held' : 'retired';
      else throw Error('Unknown review action');
      db.prepare('UPDATE soul_mimir_lessons SET state=?,correction_hash=?,reason=?,updated_at=? WHERE id=?').run(state, row.correction_hash, reason, new Date().toISOString(), row.id);
      db.prepare('UPDATE insights SET status=?,updated_at=? WHERE id=?').run(state === 'verified' ? 'active' : state === 'retired' ? 'retired' : 'dormant', new Date().toISOString(), row.id);
      return { id: row.id, result: { lessonId: row.id, state }, reason };
    });
  }
  list(scope: Scope, lessonId?: string): { lessons: unknown[]; corrections: Row[] } {
    scope = { project: scope.project, agent: learningIdentity(scope.project, scope.agent) };
    if (!fs.existsSync(path.join(this.dataDir, 'mimir.db'))) return { lessons: [], corrections: [] };
    const db = openMimir(this.dataDir);
    try {
      if (!hasLessons(db)) return { lessons: [], corrections: [] };
      const rows = lessonId ? [lesson(db, scope, lessonId)] : db.prepare('SELECT * FROM soul_mimir_lessons WHERE project=? AND agent=? ORDER BY updated_at DESC,id LIMIT 20').all(scope.project, scope.agent) as Lesson[];
      return { lessons: rows.map(row => ({ ...row, effectiveState: row.state === 'verified' && lessonValidity(db, this.dataDir, row) ? 'needs-review' : row.state,
        evidence: evidenceRows(db, row.id), sourceIds: db.prepare('SELECT experience_id FROM experience_insight_links WHERE insight_id=?').all(row.id),
        history: db.prepare('SELECT action,reason,created_at FROM soul_mimir_reviews WHERE lesson_id=? ORDER BY created_at DESC,operation LIMIT 10').all(row.id) })),
        corrections: corrections(db, scope).map(r => ({ id: r.id, correction: redactMemory(String(r.correction || r.action)).slice(0, 1000) })) };
    } finally { db.close(); }
  }
}

export function verifiedLessonContext(dataDir: string, project: string, agent: string): string {
  agent = learningIdentity(project, agent);
  if (!fs.existsSync(path.join(dataDir, 'mimir.db'))) return '';
  const db = openMimir(dataDir);
  try {
    if (!hasLessons(db)) return '';
    const rows = db.prepare("SELECT * FROM soul_mimir_lessons WHERE project=? AND agent=? AND state='verified' ORDER BY updated_at DESC,id LIMIT 20").all(project, agent) as Lesson[];
    let result = '[Reviewed lessons backed by recorded local application evidence. Not executable rules; current user instructions take precedence.]', count = 0;
    for (const row of rows) {
      if (lessonValidity(db, dataDir, row)) continue;
      const line = '\n' + JSON.stringify({ id: row.id, project, agent, lesson: redactMemory(row.description), source: 'mimir.db/soul_mimir_lessons/' + row.id });
      if (Buffer.byteLength(result + line) > 4500) continue;
      result += line; if (++count === 4) break;
    }
    return count ? result : '';
  } finally { db.close(); }
}
