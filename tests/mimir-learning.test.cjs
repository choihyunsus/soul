// Evidence review, negative feedback, durable study and real MCP/Ark regressions.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3'), { z } = require('zod');
const { LessonStore, verifiedLessonContext } = require('../dist/lib/mimir-learning');
const { StudyStore } = require('../dist/lib/mimir-study');
const { recordWorkReports, scopedMimirContext } = require('../dist/lib/mimir-scope');
const { WorkStore } = require('../dist/lib/work-store');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const scope = { project: 'sample', agent: 'alpha' };
const root = () => { fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true }); return fs.mkdtempSync(path.join(__dirname, '.tmp/learning-')); };
const body = r => r.content.map(c => c.text || '').join('\n');
const readDb = dir => new Database(path.join(dir, 'mimir.db'));
function fixture() {
  const dir = root(), store = new LessonStore(dir);
  recordWorkReports(dir, scope.project, scope.agent, { sessionId: 'source-work', summary: 'isolation source report' });
  const db = readDb(dir), sourceIds = db.prepare('SELECT id FROM experiences').all().map(r => r.id); db.close();
  const input = { ...scope, requestId: 'proposal', description: 'isolation lesson with observed evidence', sourceIds };
  const { lessonId } = store.propose(input);
  return { dir, store, lessonId, sourceIds, input };
}
function evidence(f, outcome = 'positive', applied = true, project = scope.project, agent = scope.agent) {
  const work = new WorkStore(f.dir).start(project, agent, 'isolated test fixture work'); work.completed = true;
  new WorkStore(f.dir).save(work);
  const artifact = randomUUID() + '.json', folder = path.join(f.dir, 'evidence', project); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, artifact), JSON.stringify({ schema: 'soul-evidence/v1', project, agent, lessonId: f.lessonId, sessionId: work.id, applied, outcome, method: 'isolated regression fixture, not production evidence', observation: 'Controlled test of evidence validation policy' }));
  return { ...scope, requestId: randomUUID(), lessonId: f.lessonId, sessionId: work.id, artifact };
}
const promote = (f, extra = {}) => f.store.review({ ...scope, requestId: randomUUID(), lessonId: f.lessonId, action: 'promote', reason: 'Reviewed controlled fixture evidence and user corrections', ...extra });
function ready(f) { for (let i = 0; i < 2; i++) f.store.addEvidence(evidence(f)); }

test('candidates require sources in the same scope, never graduate by importance or repetition', () => {
  const f = fixture();
  assert.throws(() => promote(f), /insufficient/);
  assert.equal(verifiedLessonContext(f.dir, 'sample', 'alpha'), '');
  const db = readDb(f.dir); db.prepare('UPDATE insights SET importance=999,confidence=1 WHERE id=?').run(f.lessonId); db.close();
  assert.throws(() => promote(f), /insufficient/);
  assert.deepEqual(f.store.propose(f.input), { lessonId: f.lessonId, state: 'candidate' });
  assert.throws(() => f.store.propose({ ...f.input, description: 'changed' }), /Retry payload changed/);
  assert.throws(() => f.store.propose({ ...f.input, project: 'another', requestId: 'other' }), /out-of-scope/);
  assert.throws(() => f.store.propose({ ...f.input, agent: 'beta', requestId: 'other' }), /out-of-scope/);
});

test('two completed-work positive applied results promote and restore read-only after reopen', () => {
  const f = fixture(); ready(f); assert.equal(promote(f).state, 'verified');
  const db = readDb(f.dir), before = db.serialize(); db.close();
  assert.match(verifiedLessonContext(f.dir, 'sample', 'alpha'), /isolation lesson/);
  assert.equal(verifiedLessonContext(f.dir, 'another', 'alpha'), ''); assert.equal(verifiedLessonContext(f.dir, 'sample', 'beta'), '');
  assert.match(scopedMimirContext(f.dir, 'sample', 'alpha', 'isolation'), new RegExp(f.lessonId));
  assert.equal(new LessonStore(f.dir).list(scope, f.lessonId).lessons[0].effectiveState, 'verified');
  const after = readDb(f.dir); assert.deepEqual(after.serialize(), before); assert.equal(after.prepare('SELECT count(*) n FROM effect_tracking').get().n, 0); after.close();
  assert.ok(!fs.existsSync(path.join(f.dir, 'rules')));
});

test('evidence retries cannot count the same work twice or alter the original record', () => {
  const f = fixture(), input = evidence(f), saved = f.store.addEvidence(input);
  assert.deepEqual(f.store.addEvidence(input), saved);
  assert.throws(() => f.store.addEvidence({ ...input, requestId: 'another-operation' }), /UNIQUE/);
  assert.throws(() => f.store.addEvidence({ ...input, artifact: 'changed.json' }), /Retry payload changed/);
  assert.throws(() => promote(f), /insufficient/);
  const db = readDb(f.dir); assert.equal(db.prepare('SELECT count(*) n FROM soul_mimir_evidence').get().n, 1); db.close();
});

test('new or edited user corrections suspend recall until explicitly reviewed', () => {
  const f = fixture(); ready(f); promote(f);
  recordWorkReports(f.dir, scope.project, scope.agent, { sessionId: 'correction-work', decisions: ['사용자 교정: isolation source must remain separate'] });
  assert.equal(verifiedLessonContext(f.dir, 'sample', 'alpha'), '');
  assert.doesNotMatch(scopedMimirContext(f.dir, 'sample', 'alpha', 'isolation'), new RegExp(f.lessonId));
  const listed = f.store.list(scope, f.lessonId); assert.equal(listed.lessons[0].effectiveState, 'needs-review');
  assert.throws(() => promote(f), /acknowledge/);
  assert.equal(promote(f, { acknowledgedCorrections: listed.corrections.map(c => c.id) }).state, 'verified');
  const db = readDb(f.dir); db.prepare("UPDATE experiences SET correction='edited correction' WHERE type='correction'").run(); db.close();
  assert.equal(verifiedLessonContext(f.dir, 'sample', 'alpha'), '');
});

test('changed sources, missing/edited artifacts and mutable insight text invalidate recall', () => {
  for (const mutation of ['source', 'artifact', 'missing', 'insight', 'compressed', 'evidence-metadata']) {
    const f = fixture(), a = evidence(f); f.store.addEvidence(a); f.store.addEvidence(evidence(f)); promote(f);
    const db = readDb(f.dir);
    if (mutation === 'source') db.prepare("UPDATE experiences SET action='changed source' WHERE id=?").run(f.sourceIds[0]);
    if (mutation === 'insight') db.prepare("UPDATE insights SET description='changed lesson' WHERE id=?").run(f.lessonId);
    if (mutation === 'compressed') db.prepare("UPDATE insights SET compressed='changed compressed lesson' WHERE id=?").run(f.lessonId);
    if (mutation === 'evidence-metadata') db.prepare("UPDATE soul_mimir_evidence SET applied=0 WHERE lesson_id=?").run(f.lessonId);
    db.close();
    const file = path.join(f.dir, 'evidence/sample', a.artifact);
    if (mutation === 'artifact') fs.appendFileSync(file, ' ');
    if (mutation === 'missing') fs.renameSync(file, file + '.retained');
    assert.equal(verifiedLessonContext(f.dir, 'sample', 'alpha'), '', mutation);
    assert.doesNotMatch(scopedMimirContext(f.dir, 'sample', 'alpha', 'isolation'), new RegExp(f.lessonId), mutation);
  }
});

test('negative outcomes hold a lesson, positive score cannot erase a negative, retire keeps history', () => {
  const f = fixture(); ready(f); promote(f);
  assert.equal(f.store.addEvidence(evidence(f, 'negative')).state, 'held');
  assert.equal(verifiedLessonContext(f.dir, 'sample', 'alpha'), '');
  assert.throws(() => promote(f), /negative-application/);
  const result = f.store.review({ ...scope, requestId: 'retire', lessonId: f.lessonId, action: 'retire', reason: 'Application failed; old conclusion withdrawn' });
  assert.equal(result.state, 'retired'); assert.throws(() => promote(f), /Terminal/);
  assert.equal(f.store.propose(f.input).state, 'retired');
  const details = f.store.list(scope, f.lessonId).lessons[0]; assert.equal(details.evidence.length, 3); assert.ok(details.history.some(h => h.action === 'retire'));
});

test('neutral/unapplied reports cannot manufacture sufficient effectiveness', () => {
  const f = fixture(); f.store.addEvidence(evidence(f, 'positive', false)); f.store.addEvidence(evidence(f));
  assert.throws(() => promote(f), /insufficient/);
  f.store.addEvidence(evidence(f, 'neutral')); f.store.addEvidence(evidence(f));
  assert.throws(() => promote(f), /insufficient/);
});

test('manual holds are durable; promotion supersedes the previous same-scope lesson atomically', () => {
  const old = fixture(); ready(old); promote(old);
  old.store.review({ ...scope, requestId: 'hold', lessonId: old.lessonId, action: 'hold', reason: 'Review wording before further use' });
  assert.equal(verifiedLessonContext(old.dir, 'sample', 'alpha'), '');
  const next = { ...old, lessonId: old.store.propose({ ...old.input, requestId: 'revision', description: 'new isolation lesson revised' }).lessonId };
  assert.throws(() => promote(next, { supersedes: old.lessonId }), /insufficient/);
  assert.equal(old.store.list(scope, old.lessonId).lessons[0].state, 'held');
  ready(next); promote(next, { supersedes: old.lessonId });
  assert.equal(old.store.list(scope, old.lessonId).lessons[0].state, 'superseded');
  const ctx = verifiedLessonContext(next.dir, 'sample', 'alpha'); assert.match(ctx, /new isolation lesson/); assert.doesNotMatch(ctx, new RegExp(old.lessonId));
});

test('artifact validation rejects path escapes, wrong scope, wrong work and unfinished work', () => {
  const f = fixture(), input = evidence(f), file = path.join(f.dir, 'evidence/sample', input.artifact);
  for (const artifact of ['../other.json', 'C:/sensitive.json', 'x:ads', '/root/secret', 'a//b']) assert.throws(() => f.store.addEvidence({ ...input, requestId: randomUUID(), artifact }));
  const original = JSON.parse(fs.readFileSync(file));
  for (const changed of [{ project: 'wrong' }, { agent: 'beta' }, { lessonId: 'wrong' }, { sessionId: 'wrong' }, { schema: 'unknown' }, { applied: 'yes' }, { observation: '' }, { method: {} }, { observation: 123 }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, ...changed })); assert.throws(() => f.store.addEvidence({ ...input, requestId: randomUUID() }));
  }
  fs.writeFileSync(file, JSON.stringify(original));
  const store = new WorkStore(f.dir), work = store.resolve('sample', 'alpha', input.sessionId); work.completed = false; store.save(work);
  assert.throws(() => f.store.addEvidence(input), /completed durable work/);
  const db = readDb(f.dir); assert.equal(db.prepare('SELECT count(*) n FROM soul_mimir_evidence').get().n, 0); db.close();
});

test('studies survive restart, isolate same topics and collect reports without voting/graduation', () => {
  const dir = root(), store = new StudyStore(dir), a = store.start(scope, 'a', 'same-topic', 'manual'), b = store.start(scope, 'b', 'same-topic', 'manual');
  const entry = { entryId: 'entry-one', action: 'Claim from primary source', outcome: 'reported failure, not repaired', sourceRef: 'local documented test source', type: 'failure' };
  store.add(scope, a.sessionId, [entry]); assert.throws(() => store.add({ ...scope, agent: 'beta' }, a.sessionId, [entry]));
  const restarted = new StudyStore(dir); assert.equal(restarted.list(scope).length, 2);
  assert.equal(restarted.add(scope, a.sessionId, [entry]).stored, 1);
  assert.throws(() => restarted.add(scope, a.sessionId, [{ ...entry, outcome: 'changed' }]), /original preserved/);
  const ended = restarted.end(scope, a.sessionId); assert.equal(ended.experienceIds.length, 2); assert.deepEqual(restarted.end(scope, a.sessionId), ended);
  assert.equal(restarted.list(scope)[0].id, b.sessionId);
  const db = readDb(dir); const rows = db.prepare('SELECT * FROM experiences').all();
  assert.ok(rows.every(r => r.project === 'sample' && r.agent === 'alpha' && r.type === 'pattern' && r.frequency === 1 && r.source_ref.startsWith('soul-study://')));
  assert.match(JSON.stringify(rows), /reported failure/); assert.equal(db.prepare('SELECT count(*) n FROM insights').get().n, 0); db.close();
});

test('study end failure freezes its original input and converges on retry', () => {
  const dir = root(), store = new StudyStore(dir), study = store.start(scope, 'fault', 'collection', 'manual');
  store.add(scope, study.sessionId, [{ entryId: 'one', action: 'reported change', outcome: 'unknown', sourceRef: 'file reference' }]);
  const db = readDb(dir); db.exec("CREATE TRIGGER fail_collection BEFORE INSERT ON experiences BEGIN SELECT RAISE(FAIL, 'test disk fault'); END");
  assert.throws(() => store.end(scope, study.sessionId), /test disk fault/);
  assert.equal(store.list(scope)[0].status, 'ending');
  assert.throws(() => store.add(scope, study.sessionId, []), /frozen/);
  db.exec('DROP TRIGGER fail_collection'); db.close();
  assert.equal(new StudyStore(dir).end(scope, study.sessionId).experienceIds.length, 2);
});
