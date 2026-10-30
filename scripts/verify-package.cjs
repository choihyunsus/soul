// Verify the actual npm tarball, not the developer checkout. Never publishes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const base = path.join(root, '.release-check'); fs.mkdirSync(base, { recursive: true });
const run = fs.mkdtempSync(path.join(base, 'package-'));
const npm = process.env.npm_execpath;
if (!npm) throw Error('Run with npm run verify:package');
function command(args, cwd) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (result.status !== 0) throw Error(`${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
async function main() {
  const packed = JSON.parse(command(['pack', '--ignore-scripts', '--json', '--pack-destination', run], root))[0];
  const files = packed.files.map(f => f.path);
  for (const file of files) {
    assert.ok(!/(^|\/)(data|tests|node_modules|\.git)(\/|$)|config\.local|\.map$|\.test\./.test(file), `Unexpected package file ${file}`);
    if (file.startsWith('dist/')) {
      const source = file.replace(/^dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts');
      assert.ok(fs.existsSync(path.join(root, source)), `Stale build output ${file}`);
    } else assert.ok(['README.md', 'README.ko.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE-APACHE', 'package.json'].includes(file), file);
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /[a-z]:[\\/](?:Users|Project[.\w-]*)[\\/]|memory[\\/]core[\\/][\w-]+-session\.md|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[a-zA-Z0-9_]{16,}/i, `Private content in ${file}`);
  }
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/lifecycle.js', 'dist/lib/mimir-schema.js', 'README.ko.md', 'CHANGELOG.md', 'LICENSE-APACHE']) assert.ok(files.includes(required), required);
  const tarball = path.join(run, packed.filename), install = path.join(run, 'installed');
  fs.mkdirSync(install); fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, name: 'soul-package-verification', version: '1.0.0' }));
  console.log(`Package boundary passed: ${files.length} files. Installing isolated artifact...`);
  command(['install', '--omit=dev', '--no-audit', '--no-fund', tarball], install);
  const audit = JSON.parse(command(['audit', '--omit=dev', '--json'], install));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  const requireInstalled = createRequire(path.join(install, 'node_modules/n2-soul/package.json'));
  const { Client } = requireInstalled('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = requireInstalled('@modelcontextprotocol/sdk/client/stdio.js');
  const entry = path.join(install, 'node_modules/n2-soul/dist/index.js'), data = path.join(run, 'data');
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: install,
      env: { ...process.env, N2_DATA_DIR: data, N2_KV_BACKEND: 'json' }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'package-verification', version: '1' }); await client.connect(transport); return client;
  };
  let client = await connect(), toolCount;
  const text = r => r.content.map(c => c.text || '').join('\n');
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, text(r)); return text(r); };
  try {
    const list = await client.listTools(); toolCount = list.tools.length;
    assert.equal(new Set(list.tools.map(t => t.name)).size, toolCount);
    await call('n2_boot', { project: 'demo', agent: 'alpha' });
    const saved = await call('n2_kv_save', { project: 'demo', agent: 'alpha', summary: 'PACKAGED_MANUAL_CHECKPOINT', importance: 1 });
    assert.match(saved, /saved: /);
    await call('n2_kv_save', { project: 'demo', agent: 'beta', summary: 'OTHER_AGENT_MARKER' });
    const started = await call('n2_work_start', { project: 'demo', agent: 'alpha', task: 'package work' });
    const sessionId = started.match(/sessionId: ([a-f0-9-]+)/)[1];
    await client.close(); client = await connect();
    const boot = await call('n2_boot', { project: 'demo', agent: 'alpha' });
    assert.match(boot, /PACKAGED_MANUAL_CHECKPOINT/); assert.match(boot, new RegExp(sessionId)); assert.doesNotMatch(boot, /OTHER_AGENT_MARKER/);
    await call('n2_work_log', { project: 'demo', agent: 'alpha', sessionId, decisions: ['package verified'] });
    fs.renameSync(path.join(data, 'kv-cache'), path.join(data, 'kv-cache.retained')); fs.writeFileSync(path.join(data, 'kv-cache'), 'failure fixture');
    const end = { project: 'demo', agent: 'alpha', sessionId, title: 'packaged test', summary: 'checkpoint restore package' };
    assert.equal((await client.callTool({ name: 'n2_work_end', arguments: end })).isError, true);
    fs.renameSync(path.join(data, 'kv-cache'), path.join(data, 'obstruction.retained')); fs.renameSync(path.join(data, 'kv-cache.retained'), path.join(data, 'kv-cache'));
    assert.match(await call('n2_work_end', end), /completed/);
    await client.close(); client = await connect();
    assert.match(await call('n2_work_end', end), /already completed/);
    assert.match(await call('n2_mimir_recall', { project: 'demo', agent: 'alpha', query: 'checkpoint restore' }), /checkpoint restore/);
    const study = JSON.parse(await call('n2_mimir_study_start', { project: 'demo', agent: 'alpha', requestId: 'study-one', topic: 'package validation' }));
    await call('n2_mimir_study_add', { project: 'demo', agent: 'alpha', sessionId: study.sessionId, entryId: 'entry-one', action: 'checked package', outcome: 'reported only', sourceRef: 'fixture' });
    const endedStudy = JSON.parse(await call('n2_mimir_study_end', { project: 'demo', agent: 'alpha', sessionId: study.sessionId }));
    const proposal = JSON.parse(await call('n2_mimir_lesson_propose', { project: 'demo', agent: 'alpha', requestId: 'proposal-one', description: 'candidate only', sourceIds: endedStudy.experienceIds }));
    assert.equal(proposal.state, 'candidate');
    assert.equal((await client.callTool({ name: 'n2_mimir_lesson_review', arguments: { project: 'demo', agent: 'alpha', requestId: 'review-one', lessonId: proposal.lessonId, action: 'promote', reason: 'no evidence supplied' } })).isError, true);
  } finally { await client.close(); }
  const hook = spawnSync(process.execPath, [path.join(path.dirname(entry), 'lifecycle.js')], { env: { ...process.env, N2_DATA_DIR: data, N2_AGENT_NAME: 'alpha', N2_PROJECT: 'demo', N2_KV_BACKEND: 'json' }, input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'packaged-hook', summary: 'PACKAGED_HOOK_CHECKPOINT' }), encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(hook.status, 0, hook.stderr); assert.equal(JSON.parse(hook.stdout).saved, true);
  const report = { version: requireInstalled('./package.json').version, tarball, sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'), files: files.length, tools: toolCount, node: process.version, platform: process.platform, productionVulnerabilities: 0, checks: ['package-private-boundary', 'isolated-install', 'MCP-restart-restore', 'failed-end-retry', 'idempotent-end', 'scoped-recall', 'study-and-evidence-gate', 'lifecycle-cli'], verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
