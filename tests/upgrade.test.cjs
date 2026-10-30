// Regression tests for identity, isolation, retention and restart-safe work completion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { CoreMemory } = require('../dist/lib/core-memory');
const { SoulEngine } = require('../dist/lib/soul-engine');
const { WorkStore } = require('../dist/lib/work-store');
const { SnapshotEngine } = require('../dist/lib/kv-cache/snapshot');
const { SoulKVCache } = require('../dist/lib/kv-cache');
const { acquireLock } = require('../dist/lib/durable');
const { memorySegment } = require('../dist/lib/kv-cache/atomic-json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const defaults = require('../dist/lib/config.default').default;
const root = () => { fs.mkdirSync(path.join(__dirname, '.tmp'), {recursive:true}); return fs.mkdtempSync(path.join(__dirname, '.tmp/upgrade-')); };
const body = r => r.content.map(c => c.text || '').join('\n');
const config = dir => ({ ...defaults, DATA_DIR: dir, MIMIR: { enabled: false }, KV_CACHE: { ...defaults.KV_CACHE, embedding: { enabled: false }, backup: { enabled: false } } });

test('Unicode identities remain separate without inferred aliases', () => {
  const dir = root(), a = new CoreMemory(dir), b = new CoreMemory(dir);
  a.write('민수', 'identity', 'alpha'); a.write('제니', 'identity', 'jenny');
  assert.equal(b.read('민수').memory.identity, 'alpha');
  assert.equal(b.read('제니').memory.identity, 'jenny');
  assert.deepEqual(b.read('지수').memory, {});
  assert.ok(!fs.existsSync(path.join(dir, 'memory/core-memory/.json')));
});

test('separate instances do not overwrite keys from stale cached core memory', () => {
  const dir = root(), a = new CoreMemory(dir), b = new CoreMemory(dir);
  a.read('alpha'); b.read('alpha'); a.write('alpha', 'one', '1'); b.write('alpha', 'two', '2');
  assert.deepEqual(a.read('alpha').memory, { one: '1', two: '2' });
});

test('corrupt core and board files are preserved instead of silently replaced', () => {
  const dir = root(), core = new CoreMemory(dir), engine = new SoulEngine(dir);
  core.write('alpha', 'one', '1');
  const file = path.join(dir, 'memory/core-memory/alpha.json'); fs.writeFileSync(file, '{bad');
  assert.throws(() => core.write('alpha', 'two', '2')); assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  fs.mkdirSync(engine.projectDir('p'), { recursive: true }); fs.writeFileSync(engine.boardPath('p'), '{bad');
  assert.throws(() => engine.setActiveWork('p', 'alpha', 'test')); assert.equal(fs.readFileSync(engine.boardPath('p'), 'utf8'), '{bad');
});

test('path escapes and Windows device aliases are rejected at storage boundaries', () => {
  const dir = root(), engine = new SoulEngine(dir);
  for (const name of ['../escape', '..', 'C:\\escape', 'p/q', 'NUL', 'con.json', 'a.', 'x:ads', ' x', 'a?']) {
    assert.throws(() => memorySegment(name), /Invalid memory/);
    assert.throws(() => engine.projectDir(name), /Invalid memory/);
    assert.throws(() => new WorkStore(dir).start(name, 'alpha', 'test'), /Invalid memory/);
  }
});

test('active writers are excluded and stale process locks are reclaimable', () => {
  const file = path.join(root(), 'guard.lock');
  const release = acquireLock(file); assert.throws(() => acquireLock(file), /busy/); release();
  fs.writeFileSync(file, '2147483647'); const release2 = acquireLock(file); release2();
});

test('same project and same agent can have independent restartable sessions', () => {
  const dir = root(), store = new WorkStore(dir);
  const a = store.start('p', 'alpha', 'first'), b = store.start('p', 'alpha', 'second'), c = store.start('p', '제니', 'third');
  assert.throws(() => store.resolve('p', 'alpha'), /ambiguous/);
  const restored = new WorkStore(dir);
  assert.equal(restored.resolve('p', 'alpha', a.id).task, 'first');
  assert.equal(restored.resolve('p', 'alpha', b.id).task, 'second');
  assert.throws(() => restored.resolve('p', 'alpha', c.id));
});

for (const backend of ['json', 'sqlite']) test(`${backend}: GC protects newest, important and sample continuity records`, async () => {
  const dir = root(); let store;
  if (backend === 'json') store = new SnapshotEngine(dir);
  else { const { SqliteStore } = require('../dist/lib/kv-cache/sqlite-store'); store = new SqliteStore(dir); await store.init(); }
  try {
    for (const [id, date, importance] of [['discard','2020-01-01',0.1], ['important','2021-01-01',1], ['last','2022-01-01',0.1]]) {
      await store.save({ id, projectName: 'p', endedAt: date + 'T00:00:00.000Z', importance });
    }
    await store.gc('p', 30, 1);
    assert.equal(await store.loadById('p', 'discard'), null);
    assert.ok(await store.loadById('p', 'important')); assert.ok(await store.loadById('p', 'last'));
    await store.save({ id: 'sample', projectName: 'continuity', endedAt: '2000-01-01T00:00:00.000Z' });
    await store.gc('continuity', 1, 0); assert.ok(await store.loadById('continuity', 'sample'));
  } finally { store.dispose?.(); }
});

test('durable checkpoint stores full summary and cannot override agent/project arguments', async () => {
  const dir = root(), kv = new SoulKVCache(dir, config(dir).KV_CACHE);
  try {
    const summary = 'KEEP_EVERY_DETAIL '.repeat(500);
    const id = await kv.save('alpha', 'p', { summary, agent: 'wrong', project: 'wrong' });
    const snap = await kv.snapshot.loadById('p', id);
    assert.equal(snap.context.summary, summary); assert.equal(snap.agentName, 'alpha');
  } finally { kv.dispose(); }
});

test('work-end ledger failure resumes with one checkpoint and one ledger', async () => {
  const dir = root(), engine = new SoulEngine(dir), handlers = {}, store = new WorkStore(dir);
  require('../dist/sequences/end').registerEndSequence({ tool: (name, ...rest) => handlers[name] = rest.at(-1) }, z, config(dir), engine);
  const work = store.start('p', 'alpha', 'test');
  const input = { agent: 'alpha', project: 'p', sessionId: work.id, title: 'test', summary: 'result', decisions: ['verified'] };
  const original = engine.writeLedger.bind(engine); engine.writeLedger = () => { throw Error('disk fault'); };
  const first = await handlers.n2_work_end(input); assert.equal(first.isError, true);
  assert.ok(!store.resolve('p', 'alpha', work.id).completed);
  engine.writeLedger = original;
  const second = await handlers.n2_work_end(input); assert.ok(!second.isError, body(second));
  assert.match(body(await handlers.n2_work_end(input)), /already completed/);
  assert.equal((await new SnapshotEngine(path.join(dir, 'kv-cache/snapshots')).list('p', 100)).length, 1);
  assert.equal(engine.readBoard('p').decisions.filter(d => d.what === 'verified').length, 1);
  const altered = await handlers.n2_work_end({ ...input, summary: 'changed' }); assert.equal(altered.isError, true);
});

test('MCP work survives process restart, logs to explicit session and completes idempotently', async () => {
  const dir = root();
  async function connect() {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../dist/index.js')], env: { ...process.env, N2_DATA_DIR: dir }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'work-restart', version: '1' }); await client.connect(transport); return client;
  }
  let client = await connect();
  try {
    const call = (name, args) => client.callTool({ name, arguments: args });
    const first = await call('n2_work_start', { agent: 'alpha', project: 'p', task: 'first' });
    const id = body(first).match(/sessionId: ([a-f0-9-]+)/)[1];
    await call('n2_work_start', { agent: 'alpha', project: 'p', task: 'second' });
    const ambiguous = await call('n2_work_log', { project: 'p', decisions: ['wrong'] }); assert.equal(ambiguous.isError, true);
    await client.close(); client = await connect();
    const logged = await call('n2_work_log', { project: 'p', agent: 'alpha', sessionId: id, decisions: ['RIGHT_SESSION'] }); assert.ok(!logged.isError, body(logged));
    const args = { project: 'p', agent: 'alpha', sessionId: id, title: 'done', summary: 'done' };
    const ended = await call('n2_work_end', args); assert.ok(!ended.isError, body(ended));
    await client.close(); client = await connect();
    assert.match(body(await call('n2_work_end', args)), /already completed/);
    const snap = await new SnapshotEngine(path.join(dir, 'kv-cache/snapshots')).loadById('p', id);
    assert.deepEqual(snap.context.decisions, ['RIGHT_SESSION']);
  } finally { await client.close(); }
});

test('backup round-trip retains importance, provenance and full original context', async () => {
  const dir = root(), snapDir = path.join(dir, 'kv-cache/snapshots'), store = new SnapshotEngine(snapDir);
  const id = await store.save({ projectName: 'p', importance: 1, context: { summary: 'EXACT_ORIGINAL', todo: ['NEXT'] } });
  const original = await store.loadById('p', id); original.source = { kind: 'test', digest: 'provenance' };
  const originalPath = path.join(snapDir, 'p', original.endedAt.slice(0, 10), id + '.json');
  fs.writeFileSync(originalPath, JSON.stringify(original));
  const { BackupManager } = require('../dist/lib/kv-cache/backup'); const backup = new BackupManager(dir);
  const result = await backup.backup('p', { full: true }); assert.ok(result.backupId);
  fs.renameSync(originalPath, originalPath + '.retained');
  await backup.restore('p', result.backupId);
  assert.deepEqual(await store.loadById('p', id), original);
});

test('two SQLite instances retain each other writes and dispose cannot overwrite disk', async () => {
  const { SqliteStore } = require('../dist/lib/kv-cache/sqlite-store');
  const dir = root(), a = new SqliteStore(dir), b = new SqliteStore(dir); await a.init(); await b.init();
  await a.save({ id: 'one', projectName: 'p' }); await b.loadLatest('p');
  await a.save({ id: 'two', projectName: 'p' }); await b.save({ id: 'three', projectName: 'p' });
  a.dispose(); b.dispose(); const c = new SqliteStore(dir); await c.init();
  try { assert.equal((await c.list('p', 20)).length, 3); } finally { c.dispose(); }
});

test('legacy case-sensitive identity reads its existing file without merging another identity', () => {
  const dir = root(), folder = path.join(dir, 'memory/core-memory'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'testbot.json'), JSON.stringify({ agent: 'TestBot', memory: { original: 'yes' } }));
  assert.equal(new CoreMemory(dir).read('TestBot').memory.original, 'yes');
  assert.throws(() => new CoreMemory(dir).read('testbot'), /identity/);
});

test('valid JSON with invalid snapshot identity cannot become a restored memory', async () => {
  const dir = root(), store = new SnapshotEngine(dir), day = path.join(dir, 'p', '2026-01-01');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'bad.json'), JSON.stringify({ id: 'other', projectName: 'another', context: { summary: 'WRONG' } }));
  assert.equal(await store.loadLatest('p'), null);
  assert.ok(fs.existsSync(path.join(day, 'bad.json')));
});

test('parallel async writes publish complete values without temporary name collisions', async () => {
  const { writeJsonAsync } = require('../dist/lib/utils'); const dir = root(), file = path.join(dir, 'value.json');
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeJsonAsync(file, { i, payload: String(i).repeat(1000) })));
  const result = JSON.parse(fs.readFileSync(file)); assert.equal(result.payload, String(result.i).repeat(1000));
  assert.deepEqual(fs.readdirSync(dir), ['value.json']);
});
