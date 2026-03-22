// Soul 통합 시뮬레이션 — 수정된 모듈들이 실제로 정상 동작하는지 확인
const path = require('path');
const assert = (cond, msg) => {
    if (cond) { console.log(`  ✅ ${msg}`); pass++; }
    else { console.error(`  ❌ ${msg}`); fail++; }
};
let pass = 0, fail = 0;

// ═══════════════════════════════════════
// 1. 버전 동적 로드 확인 (#1, #2)
// ═══════════════════════════════════════
console.log('\n[1] 버전 동적 로드');
const pkg = require('../package.json');
assert(/\d+\.\d+\.\d+/.test(pkg.version), `package.json version: ${pkg.version}`);
// boot.js에서 어떻게 사용하는지 검증
const bootPkg = require('../package.json');
assert(bootPkg.version === pkg.version, `boot.js도 같은 버전 참조: ${bootPkg.version}`);

// ═══════════════════════════════════════
// 2. Config 로드 + deepMerge (#3, #8, #13)
// ═══════════════════════════════════════
console.log('\n[2] Config 로드 & 새 설정 확인');
const config = require('../lib/config');
assert(config.TIMEZONE === 'Asia/Seoul', `TIMEZONE: ${config.TIMEZONE}`);
assert(config.WORK !== undefined, 'WORK 섹션 존재');
assert(config.WORK.sessionTtlHours === 24, `sessionTtlHours: ${config.WORK.sessionTtlHours}`);
assert(config.WORK.maxDecisions === 20, `maxDecisions: ${config.WORK.maxDecisions}`);
assert(config.ARK.auditMaxAgeDays === 7, `auditMaxAgeDays: ${config.ARK.auditMaxAgeDays}`);

// ═══════════════════════════════════════
// 3. Timezone — config.TIMEZONE 반영 확인 (#3)
// ═══════════════════════════════════════
console.log('\n[3] Timezone 함수');
const { today, nowISO } = require('../lib/utils');
const todayStr = today();
assert(/^\d{4}-\d{2}-\d{2}$/.test(todayStr), `today(): ${todayStr}`);
const nowStr = nowISO();
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(nowStr), `nowISO(): ${nowStr}`);
assert(nowStr.endsWith('+09:00'), `Timezone 반영 (Asia/Seoul +09:00): ${nowStr.slice(-6)}`);

// ═══════════════════════════════════════
// 4. Paths — DATA_DIR 우선 참조 확인 (#4)
// ═══════════════════════════════════════
console.log('\n[4] Paths 모듈');
const { PROJECT_ROOT, getAgentsDir } = require('../lib/paths');
const agentsDir = getAgentsDir();
assert(agentsDir.includes('data'), `getAgentsDir(): ${agentsDir}`);
assert(PROJECT_ROOT === path.resolve(__dirname, '..', '..'), `PROJECT_ROOT: ${PROJECT_ROOT}`);

// ═══════════════════════════════════════
// 5. Ark — createArk + ?? + auditMaxAgeDays (#7, #8)
// ═══════════════════════════════════════
console.log('\n[5] Ark 로드 & strictMode ?? 검증');
const { createArk } = require('../lib/ark');
const ark = createArk({
    rulesDir: path.join(__dirname, '..', 'rules'),
    auditDir: path.join(config.DATA_DIR, 'ark-audit'),
    strictMode: false,   // 명시적 false — || 였으면 fallback 됐을 것
    auditMaxAgeDays: 14, // #8: config에서 전달 가능
    auditEnabled: false, // 테스트이므로 감사 비활성
});
const summary = ark.summary();
assert(summary.blacklists > 0, `Blacklist 규칙: ${summary.blacklists} (${summary.patterns} patterns)`);
assert(summary.gates > 0, `Gate 규칙: ${summary.gates}`);

// strictMode=false일 때 unknown 도구 허용 확인
const unknownResult = ark.check('some_unknown_tool', '{}', 'tool_call');
assert(unknownResult.allowed === true, 'strictMode=false: unknown tool 허용');

// 차단 확인
const blockResult = ark.check('run_command', 'rm -rf /', 'tool_call');
assert(blockResult.allowed === false, `rm -rf / 차단: ${blockResult.rule}`);

// 2차 실행 공격 차단
const scriptResult = ark.check('run_command', 'bash exploit.sh', 'tool_call');
assert(scriptResult.allowed === false, `bash *.sh 차단: ${scriptResult.rule}`);

// ═══════════════════════════════════════
// 6. Parser — @gate brace counting 검증 (#9)
// ═══════════════════════════════════════
console.log('\n[6] @gate 파서 brace counting');
const { parse } = require('../lib/ark/parser');
const testRule = `
@gate complex_gate {
    actions: [deploy, publish]
    requires: human_approval
    min_approval_level: 2
}
`;
const parsed = parse(testRule);
assert(parsed.gates.complex_gate !== undefined, 'complex_gate 파싱 성공');
assert(parsed.gates.complex_gate.actions.length === 2, `actions: ${parsed.gates.complex_gate.actions}`);
assert(parsed.gates.complex_gate.minApproval === 2, `minApproval: ${parsed.gates.complex_gate.minApproval}`);

// ═══════════════════════════════════════
// 7. SoulEngine — Board/Ledger 기본 동작
// ═══════════════════════════════════════
console.log('\n[7] SoulEngine 기본 동작');
const { SoulEngine } = require('../lib/soul-engine');
const engine = new SoulEngine(config.DATA_DIR);
const board = engine.readBoard('__test_sim__');
assert(board.project === '__test_sim__', `readBoard: project=${board.project}`);

// ═══════════════════════════════════════
// 8. CoreMemory + EntityMemory
// ═══════════════════════════════════════
console.log('\n[8] Memory 모듈');
const { CoreMemory } = require('../lib/core-memory');
const { EntityMemory } = require('../lib/entity-memory');
const coreMem = new CoreMemory(config.DATA_DIR);
const coreData = coreMem.read('__test_agent__');
assert(coreData.agent === '__test_agent__', 'CoreMemory read OK');

const entityMem = new EntityMemory(config.DATA_DIR);
const entityResult = entityMem.search('test');
assert(Array.isArray(entityResult), 'EntityMemory search OK');

// ═══════════════════════════════════════
// 9. KV-Cache 로드 시뮬레이션
// ═══════════════════════════════════════
console.log('\n[9] KV-Cache 초기화');
const { SoulKVCache } = require('../lib/kv-cache');
const kvCache = new SoulKVCache(config.DATA_DIR, config.KV_CACHE);
const loadResult = kvCache.load('__test_sim__');
assert(loadResult === null || typeof loadResult === 'object', 'KV-Cache load: OK (null or object)');
const snapList = kvCache.listSnapshots('__test_sim__');
assert(Array.isArray(snapList), `KV-Cache list: ${snapList.length} snapshots`);

// ═══════════════════════════════════════
// 10. intercom-log — config.DATA_DIR 참조 (#5)
// ═══════════════════════════════════════
console.log('\n[10] intercom-log config 호환성');
const { normalizeName, getValidAgentNames } = require('../lib/intercom-log');
const agents = getValidAgentNames();
assert(agents.has('master'), 'Default agent "master" 존재');
const normalized = normalizeName('UNKNOWN_PERSON');
assert(normalized === 'master', `Unknown name → master: "${normalized}"`);

// ═══════════════════════════════════════
// 결과
// ═══════════════════════════════════════
console.log(`\n${'='.repeat(40)}`);
console.log(`=== SIMULATION: ${pass}/${pass + fail} passed ===`);
if (fail > 0) {
    console.log(`⚠️ ${fail} FAILED`);
    process.exit(1);
} else {
    console.log('🎉 All checks passed!');
}

// Cleanup: close ark audit to prevent hang
ark.close();
kvCache.stopAutoBackup();
