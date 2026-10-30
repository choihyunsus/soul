// Scope, evidence fidelity and durable retry regressions for sample Mimir collection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { recordWorkReports, scopedMimirContext } = require('../dist/lib/mimir-scope');
const { mimirActivate, mimirRecall } = require('../dist/tools/mimir-lifecycle');
const { SCHEMA_SQL } = require('../dist/lib/mimir-schema');
const { WorkStore } = require('../dist/lib/work-store');
const { SoulEngine } = require('../dist/lib/soul-engine');
const { SnapshotEngine } = require('../dist/lib/kv-cache/snapshot');
const defaults = require('../dist/lib/config.default').default;
const root = () => { fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true }); return fs.mkdtempSync(path.join(__dirname, '.tmp/mimir-')); };
const config = dir => ({ ...defaults, DATA_DIR: dir, KV_CACHE: { ...defaults.KV_CACHE, embedding: { enabled: false }, backup: { enabled: false } } });
const body = r => r.content.map(c => c.text || '').join('\n');
function dbAt(dir) { const db = new Database(path.join(dir, 'mimir.db')); db.exec(SCHEMA_SQL); return db; }
function addExperience(db, id, project = 'sample', agent = 'alpha', action = 'isolation ' + id) {
  db.prepare(`INSERT INTO experiences(id,agent,project,type,category,context,action,outcome,created_at)
    VALUES (?,?,?,'pattern','workflow','source',?,'reported','2020-01-01T00:00:00.000Z')`).run(id, agent, project, action);
}
function addInsight(db, id, links, agent = 'alpha', status = 'active') {
  db.prepare(`INSERT INTO insights(id,agent,description,category,status,updated_at) VALUES (?,?,?,'workflow',?,'2020-01-01T00:00:00.000Z')`).run(id, agent, 'isolation ' + id, status);
  for (const [experience, relation = 'supports'] of links) db.prepare('INSERT INTO experience_insight_links VALUES (?,?,?)').run(experience, id, relation);
}

test('same topic cannot cross project/agent boundaries or uncertain insight provenance', () => {
  const dir = root(), db = dbAt(dir);
  addExperience(db, 'OWN'); addExperience(db, 'OTHER_PROJECT', 'other-project'); addExperience(db, 'OTHER_AGENT', 'sample', 'beta');
  addInsight(db, 'VALID', [['OWN']]); addInsight(db, 'UNLINKED', []);
  addInsight(db, 'MIXED_PROJECT', [['OWN'], ['OTHER_PROJECT']]); addInsight(db, 'MIXED_AGENT', [['OWN'], ['OTHER_AGENT']]);
  addInsight(db, 'CONTRADICTED', [['OWN', 'contradicts']]); addInsight(db, 'WRONG_OWNER', [['OWN']], 'beta');
  addInsight(db, 'RETIRED', [['OWN']], 'alpha', 'retired');
  db.exec('PRAGMA foreign_keys=OFF'); addInsight(db, 'MISSING_SOURCE', [['OWN'], ['missing']]); db.exec('PRAGMA foreign_keys=ON');
  const before = db.serialize(); db.close();
  const text = scopedMimirContext(dir, 'sample', 'alpha', 'isolation');
  assert.match(text, /VALID/); assert.match(text, /OWN/);
  for (const bad of ['OTHER_PROJECT', 'OTHER_AGENT', 'UNLINKED', 'MIXED_PROJECT', 'MIXED_AGENT', 'CONTRADICTED', 'WRONG_OWNER', 'RETIRED', 'MISSING_SOURCE']) assert.ok(!text.includes(bad), bad);
  const after = new Database(path.join(dir, 'mimir.db'), { readonly: true }); assert.deepEqual(after.serialize(), before); after.close();
  assert.deepEqual(fs.readdirSync(dir), ['mimir.db']);
});

test('read wrappers never initialize legacy engine, mutate rules or create an empty database', async () => {
  const dir = root(), factory = () => { throw Error('legacy engine must not be invoked'); };
  assert.equal(await mimirActivate(config(dir), 'sample', 'alpha', factory), '');
  assert.equal(await mimirRecall(config(dir), 'isolation', 'sample', 'alpha', factory), '');
  assert.deepEqual(fs.readdirSync(dir), []);
  const db = dbAt(dir); addExperience(db, 'OWN'); db.close();
  assert.match(await mimirRecall(config(dir), 'isolation', 'sample', 'alpha', factory), /OWN/);
  assert.equal(await mimirRecall(config(dir), 'ㅇㅇ 계속해', 'sample', 'alpha', factory), '');
});

test('reports preserve failures and explicit corrections without inventing successful outcomes', () => {
  const dir = root();
  assert.deepEqual(recordWorkReports(dir, 'sample', 'alpha', {
    sessionId: 'work-one', summary: 'fixed code but test failed; error is still unresolved',
    decisions: ['사용자 교정: 프로젝트와 에이전트의 기록을 분리한다', 'not a correction just because fix and error appear'],
    filesModified: [{ path: 'a.ts', desc: 'attempted fix; password=not-a-real-test-secret' }],
  }), { inserted: 4, duplicates: 0 });
  const db = new Database(path.join(dir, 'mimir.db'));
  const rows = db.prepare('SELECT * FROM experiences').all();
  assert.equal(rows.filter(r => r.type === 'correction').length, 1);
  assert.equal(rows.filter(r => r.type === 'success' || r.type === 'failure').length, 0);
  assert.ok(rows.every(r => r.agent === 'alpha' && r.project === 'sample' && r.session_id === 'work-one' && r.frequency === 1));
  assert.match(rows.find(r => r.type === 'correction').outcome, /not verified/);
  assert.match(JSON.stringify(rows), /still unresolved/);
  assert.doesNotMatch(JSON.stringify(rows), /applied successfully|Work completed|not-a-real-test-secret/);
  assert.equal(db.prepare('SELECT count(*) n FROM insights').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM effect_tracking').get().n, 0);
  db.close();
});

test('retry receipts preserve one copy and roll back an entire changed batch', () => {
  const dir = root(), report = { sessionId: 'stable', decisions: ['decision original'] };
  assert.equal(recordWorkReports(dir, 'sample', 'alpha', report).inserted, 1);
  assert.deepEqual(recordWorkReports(dir, 'sample', 'alpha', report), { inserted: 0, duplicates: 1 });
  assert.throws(() => recordWorkReports(dir, 'sample', 'alpha', { ...report, summary: 'must roll back', decisions: ['changed'] }), /original preserved/);
  const db = new Database(path.join(dir, 'mimir.db'));
  assert.equal(db.prepare('SELECT count(*) n FROM experiences').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM soul_mimir_ingest').get().n, 1);
  assert.equal(db.prepare('SELECT frequency FROM experiences').get().frequency, 1); db.close();
  assert.equal(recordWorkReports(dir, 'sample', 'alpha', { ...report, sessionId: 'different' }).inserted, 1);
});

test('input boundaries and corrupted DB do not overwrite existing data', () => {
  const dir = root();
  for (const bad of ['../escape', 'NUL', 'x/y', 'x:ads']) {
    assert.throws(() => recordWorkReports(dir, bad, 'alpha', { sessionId: 's', summary: 'x' }));
    assert.throws(() => recordWorkReports(dir, 'p', bad, { sessionId: 's', summary: 'x' }));
    assert.throws(() => recordWorkReports(dir, 'p', 'alpha', { sessionId: bad, summary: 'x' }));
    assert.throws(() => scopedMimirContext(dir, bad, 'alpha', 'x'));
  }
  assert.throws(() => recordWorkReports(dir, 'p', 'alpha', { sessionId: 's', summary: 'a'.repeat(32001) }), /exceeds/);
  assert.throws(() => recordWorkReports(dir, 'p', 'alpha', { sessionId: 's', decisions: Array(201).fill('report') }), /exceeds/);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.writeFileSync(path.join(dir, 'mimir.db'), 'corrupt but retained');
  assert.throws(() => recordWorkReports(dir, 'p', 'alpha', { sessionId: 's', summary: 'new' }));
  assert.equal(fs.readFileSync(path.join(dir, 'mimir.db'), 'utf8'), 'corrupt but retained');
});

test('recall bounds UTF-8 output, redacts content and provenance, and ranks recent corrections first', () => {
  const dir = root(), db = dbAt(dir);
  for (let i = 0; i < 8; i++) { addExperience(db, 'old-' + i); addInsight(db, 'old-insight-' + i, [['old-' + i]]); }
  db.close();
  recordWorkReports(dir, 'sample', 'alpha', { sessionId: 'new', decisions: ['사용자 교정: isolation 최신 교정 password=fake-secret 내용 '.repeat(50)] });
  const text = scopedMimirContext(dir, 'sample', 'alpha', 'isolation');
  assert.match(text.split('\n')[1], /최신 교정/); assert.ok(Buffer.byteLength(text) <= 4500); assert.doesNotMatch(text, /fake-secret/);
  const update = new Database(path.join(dir, 'mimir.db')); update.prepare('UPDATE experiences SET source_ref=?').run('password=provenance-secret'); update.close();
  assert.doesNotMatch(scopedMimirContext(dir, 'sample', 'alpha', 'isolation'), /provenance-secret/);
  assert.equal(scopedMimirContext(dir, 'sample', 'alpha', 'isolation', 10), '');
  assert.throws(() => scopedMimirContext(dir, 'sample', 'alpha', 'isolation', NaN));
});

test('manual overlay requires explicit scope and never calls legacy initialization', async () => {
  const dir = root(), handlers = {};
  require('../dist/tools/mimir-learning').registerLearningTools({ tool: (name, ...rest) => handlers[name] = rest.at(-1) }, z, config(dir));
  assert.equal((await handlers.n2_mimir_recall({ query: 'isolation' })).isError, true);
  assert.deepEqual(fs.readdirSync(dir), []);
  recordWorkReports(dir, 'sample', 'alpha', { sessionId: 's', summary: 'isolation own record' });
  require('../dist/lib/context').setAgentName('alpha');
  assert.match(body(await handlers.n2_mimir_recall({ project: 'sample', query: 'isolation' })), /own record/);
  assert.doesNotMatch(body(await handlers.n2_mimir_recall({ project: 'other-project', query: 'isolation' })), /own record/);
});

test('separate process retries the same reports with no frequency reinforcement', () => {
  const dir = root(), report = { sessionId: 'restart', summary: 'restart source retained' };
  recordWorkReports(dir, 'sample', 'alpha', report);
  const result = spawnSync(process.execPath, ['-e', `const m=require('./dist/lib/mimir-scope');process.stdout.write(JSON.stringify(m.recordWorkReports(process.env.MIMIR_TEST_DIR,'sample','alpha',JSON.parse(process.env.MIMIR_TEST_REPORT))))`], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MIMIR_TEST_DIR: dir, MIMIR_TEST_REPORT: JSON.stringify(report) }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { inserted: 0, duplicates: 1 });
});

test('failed auxiliary collection is discoverable after restart and retry saves once', async () => {
  const dir = root(), handlers = {}, engine = new SoulEngine(dir), store = new WorkStore(dir);
  const register = () => {
    const server = { tool: (name, ...rest) => handlers[name] = rest.at(-1) };
    require('../dist/sequences/end').registerEndSequence(server, z, config(dir), engine);
    require('../dist/sequences/work').registerWorkSequence(server, z, config(dir), engine);
  };
  register();
  const work = store.start('sample', 'alpha', 'test failed collection');
  const input = { sessionId: work.id, agent: 'alpha', project: 'sample', title: 'done', summary: 'actual work completed', decisions: ['사용자 교정: retain distinct scope'] };
  fs.mkdirSync(path.join(dir, 'mimir.db'));
  const first = await handlers.n2_work_end(input);
  assert.ok(!first.isError, body(first)); assert.match(body(first), /collection FAILED/);
  const failed = store.resolve('sample', 'alpha', work.id); assert.equal(failed.completed, true); assert.equal(failed.learningStatus, 'failed');
  register();
  assert.match(body(await handlers.n2_work_sessions({ project: 'sample' })), /"learningStatus":"failed"/);
  assert.equal((await handlers.n2_work_end({ ...input, summary: 'changed' })).isError, true);
  fs.renameSync(path.join(dir, 'mimir.db'), path.join(dir, 'mimir-obstruction.retained'));
  const retry = await handlers.n2_work_end(input); assert.match(body(retry), /Mimir reports saved: 2 new/);
  assert.equal(store.resolve('sample', 'alpha', work.id).learningStatus, 'saved');
  assert.equal(body(await handlers.n2_work_sessions({ project: 'sample' })), '[]');
  assert.match(body(await handlers.n2_work_end(input)), /already completed/);
  assert.equal((await new SnapshotEngine(path.join(dir, 'kv-cache/snapshots')).list('sample', 100)).length, 1);
  const db = new Database(path.join(dir, 'mimir.db')); assert.equal(db.prepare('SELECT count(*) n FROM experiences').get().n, 2); db.close();
  assert.equal(engine.readBoard('sample').decisions.length, 1);
});
