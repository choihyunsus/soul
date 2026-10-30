// Distribution boundaries exercised without a personal installation or data directory.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { z } = require('zod');
const { SoulKVCache } = require('../dist/lib/kv-cache');
const { SnapshotEngine } = require('../dist/lib/kv-cache/snapshot');
const { SqliteStore } = require('../dist/lib/kv-cache/sqlite-store');
const { WorkStore } = require('../dist/lib/work-store');
const { SoulEngine } = require('../dist/lib/soul-engine');
const { CoreMemory } = require('../dist/lib/core-memory');
const { runLifecycle } = require('../dist/lifecycle');
const { recallQuery, matchRecall } = require('../dist/lib/recall-match');
const defaults = require('../dist/lib/config.default').default;
const root = () => { fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true }); return fs.mkdtempSync(path.join(__dirname, '.tmp/distribution-')); };
const body = r => r.content.map(c => c.text || '').join('\n');

test('generic identities preserve case and Unicode without aliases', () => {
  const store = new CoreMemory(root());
  for (const agent of ['alpha', 'Alpha', '민수', '지수']) store.write(agent, 'owner', agent);
  for (const agent of ['alpha', 'Alpha', '민수', '지수']) assert.equal(store.read(agent).memory.owner, agent);
});

for (const backend of ['json', 'sqlite']) {
  test(`${backend}: scheduled backup discovers projects in the configured storage directory`, async () => {
    const dir = root(), cache = new SoulKVCache(dir, { backend, snapshotDir: path.join(dir, 'custom-json'), sqliteDir: path.join(dir, 'custom-sqlite'), backup: { enabled: true, schedule: 'manual', keepCount: 7, incremental: false } });
    try {
      await cache.save('alpha', '_demo', { summary: 'scheduled backup' });
      await cache._runAutoBackup();
      assert.equal(cache.listBackups('_demo').length, 1);
    } finally { cache.dispose(); }
  });

  test(`${backend}: scoped load/search, source metadata and per-agent GC protection`, async () => {
    const dir = root(), cache = new SoulKVCache(dir, { backend }); await cache.ready();
    try {
      const store = cache.snapshot;
      await store.save({ id: 'a', agentName: 'alpha', projectName: 'p', endedAt: '2020-01-01T00:00:00Z', source: { kind: 'fixture', ref: 'document-1' }, context: { summary: 'checkpoint restore alpha' } });
      await store.save({ id: 'b', agentName: 'beta', projectName: 'p', endedAt: '2021-01-01T00:00:00Z', context: { summary: 'checkpoint restore beta' } });
      await store.touch('p', 'a');
      assert.deepEqual((await store.loadById('p', 'a')).source, { kind: 'fixture', ref: 'document-1' });
      assert.equal((await cache.load('p', { agent: 'alpha' })).id, 'a');
      assert.equal(await cache.load('p', { agent: 'Alpha' }), null);
      const before = (await store.loadById('p', 'a')).accessCount;
      const found = await cache.searchScoped('체크포인트 복원', 'p', 'alpha');
      assert.deepEqual(found.results.map(r => r.id), ['a']);
      assert.equal((await store.loadById('p', 'a')).accessCount, before);
      await store.gc('p', 1, 1);
      assert.ok(await store.loadById('p', 'a')); assert.ok(await store.loadById('p', 'b'));
    } finally { cache.dispose(); }
  });

  test(`${backend}: work-end waits for backend initialization and retries without duplicates`, async () => {
    const dir = root(), handlers = {}, store = new WorkStore(dir), config = { ...defaults, DATA_DIR: dir, KV_CACHE: { ...defaults.KV_CACHE, backend } };
    require('../dist/sequences/end').registerEndSequence({ tool: (name, ...rest) => handlers[name] = rest.at(-1) }, z, config, new SoulEngine(dir));
    const work = store.start('p', 'alpha', 'test'), input = { project: 'p', agent: 'alpha', sessionId: work.id, title: 'done', summary: 'checkpoint summary' };
    const result = await handlers.n2_work_end(input); assert.ok(!result.isError, body(result));
    assert.match(body(await handlers.n2_work_end(input)), /already completed/);
    const cache = new SoulKVCache(dir, { backend }); await cache.ready();
    try { assert.equal((await cache.snapshot.list('p', 100)).length, 1); }
    finally { cache.dispose(); }
  });
}

test('tiered reads see checkpoints saved by a different cache instance', async () => {
  const dir = root(), a = new SoulKVCache(dir, defaults.KV_CACHE), b = new SoulKVCache(dir, defaults.KV_CACHE);
  try {
    await a.save('alpha', 'p', { summary: 'first' });
    const latest = await b.save('alpha', 'p', { summary: 'second' });
    assert.equal((await a.load('p')).id, latest);
  } finally { a.dispose(); b.dispose(); }
});

test('custom snapshot location and rapid backups preserve full metadata', async () => {
  const dir = root(), cache = new SoulKVCache(dir, { backend: 'json', snapshotDir: path.join(dir, 'custom'), backup: { enabled: true, dir: path.join(dir, 'backups'), keepCount: 7, incremental: false, schedule: 'manual' } });
  try {
    const id = await cache.save('alpha', 'p', { summary: 'original', importance: 1 });
    const first = await cache.backup('p', { full: true }), second = await cache.backup('p', { full: true });
    assert.notEqual(first.backupId, second.backupId); assert.equal(first.snapshots, 1);
    const snap = await cache.snapshot.loadById('p', id), file = path.join(dir, 'custom/p', snap.endedAt.slice(0, 10), id + '.json');
    fs.renameSync(file, file + '.retained');
    assert.equal((await cache.restore('p', second.backupId)).restored, 1);
    assert.deepEqual(await cache.snapshot.loadById('p', id), snap);
  } finally { cache.dispose(); }
});

test('correction ranking and lexical boundaries prevent unrelated substring recall', async () => {
  assert.equal(matchRecall('markdown archive', recallQuery(['ark'])).eligible, false);
  const cache = new SoulKVCache(root());
  try {
    await cache.save('alpha', 'p', { summary: 'checkpoint restore checkpoint restore' });
    const correction = await cache.save('alpha', 'p', { summary: 'User correction: checkpoint restore must keep original text' });
    assert.equal((await cache.searchScoped('checkpoint restore', 'p', 'alpha')).results[0].id, correction);
    assert.deepEqual((await cache.searchScoped('ㅇㅇ 계속해', 'p', 'alpha')).results, []);
  } finally { cache.dispose(); }
});

test('optional lifecycle saves separately, redacts, retries and restores the same conversation', async () => {
  const dir = root(), env = { dataDir: dir, agent: 'alpha', project: 'p', transcriptRoot: dir };
  const cache = new SoulKVCache(dir);
  const manual = await cache.save('alpha', 'p', { summary: 'MANUAL_PRIORITY' }); cache.dispose();
  const transcript = path.join(dir, 'conversation.jsonl');
  fs.writeFileSync(transcript, [JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'AUXILIARY_ONLY password=fixture-secret' } }), '{unfinished'].join('\n'));
  const input = { hook_event_name: 'PreCompact', session_id: 'conversation-1', transcript_path: transcript };
  const saved = await runLifecycle(input, env), replay = await runLifecycle(input, env);
  assert.equal(saved.saved, true); assert.equal(replay.checkpointId, saved.checkpointId);
  const boot = await runLifecycle({ hook_event_name: 'SessionStart', session_id: 'conversation-1' }, env);
  assert.equal(boot.checkpointId, manual); assert.match(boot.context, /MANUAL_PRIORITY/); assert.match(boot.context, /AUXILIARY_ONLY/); assert.doesNotMatch(boot.context, /fixture-secret/);
  const other = await runLifecycle({ hook_event_name: 'SessionStart', session_id: 'conversation-2' }, env);
  assert.doesNotMatch(other.context, /AUXILIARY_ONLY/);
  const unrelated = await runLifecycle({ hook_event_name: 'SessionStart', session_id: 'conversation-1' }, { ...env, agent: 'beta' });
  assert.equal(unrelated.restored, false);
  const store = new SnapshotEngine(path.join(dir, 'kv-cache/snapshots'));
  assert.equal((await store.list(saved.auxiliaryProject, 10)).length, 1);
  assert.equal((await store.loadLatest('p')).id, manual);
});

test('lifecycle rejects missing scope, unsupported events and paths outside the configured root', async () => {
  const dir = root(), env = { dataDir: dir, agent: 'alpha', project: 'p', transcriptRoot: path.join(dir, 'allowed') };
  fs.mkdirSync(env.transcriptRoot); const outside = path.join(dir, 'outside.jsonl'); fs.writeFileSync(outside, '{}');
  const input = { hook_event_name: 'Stop', session_id: 'c' };
  await assert.rejects(runLifecycle(input, { ...env, agent: '' }), /Invalid memory/);
  await assert.rejects(runLifecycle(input, env), /No summary/);
  await assert.rejects(runLifecycle({ ...input, transcript_path: outside }, env), /outside/);
  await assert.rejects(runLifecycle({ ...input, hook_event_name: 'Unknown' }, env));
  assert.ok(!fs.existsSync(path.join(dir, 'lifecycle')));
});

test('failed atomic publication preserves the previous value and removes temporary artifacts', async () => {
  const fsp = require('node:fs/promises'), { atomicJsonWrite } = require('../dist/lib/kv-cache/atomic-json');
  const dir = root(), file = path.join(dir, 'checkpoint.json');
  await atomicJsonWrite(file, { original: true });
  const rename = fsp.rename; fsp.rename = async () => { throw Error('controlled publication failure'); };
  try { await assert.rejects(atomicJsonWrite(file, { replacement: true }), /controlled publication failure/); }
  finally { fsp.rename = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { original: true });
  assert.deepEqual(fs.readdirSync(dir), ['checkpoint.json']);
});
