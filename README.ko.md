🇬🇧 [English](README.md)

# 🧠 Soul

**AI 에이전트는 세션이 끝나면 모든 걸 잊어버립니다. Soul이 그걸 해결합니다.**

Cursor, VS Code Copilot 등 MCP 호환 AI 에이전트와 새 채팅을 시작할 때마다, 에이전트는 이전에 뭘 했는지 전혀 모른 채 처음부터 시작합니다. Soul은 에이전트에게 이런 능력을 부여하는 MCP 서버입니다:

- 🧠 **영구 기억** — 세션이 끝나도 기억이 유지됩니다
- 🤝 **인수인계** — 한 에이전트가 다른 에이전트의 작업을 이어받을 수 있습니다
- 📝 **작업 이력** — 모든 작업이 변경 불가능한 로그로 기록됩니다
- 🗂️ **공유 두뇌** — 여러 에이전트가 같은 컨텍스트를 읽고 쓸 수 있습니다
- 🏷️ **엔티티 메모리** — 인물, 하드웨어, 프로젝트를 자동 추적합니다 (v5.0)
- 💡 **코어 메모리** — 에이전트별 핵심 사실이 항상 로드됩니다 (v5.0)

> ⚡ **Soul은 N2 Browser의 작은 부속품 하나입니다** — 우리가 만들고 있는 AI 네이티브 브라우저의 일부예요. 멀티 에이전트 오케스트레이션, 실시간 도구 라우팅, 에이전트 간 통신 등 훨씬 더 많은 기능들이 현재 테스트 중입니다. 이건 시작에 불과합니다.

## 빠른 시작

### 1. 설치

```bash
git clone https://github.com/user/soul.git
cd soul
npm install
```

### 2. MCP 설정에 Soul 추가

```json
{
  "mcpServers": {
    "soul": {
      "command": "node",
      "args": ["/path/to/soul/index.js"]
    }
  }
}
```

### 3. 에이전트에게 Soul 사용법 알려주기

에이전트의 규칙 파일 (`.md`, `.cursorrules`, 시스템 프롬프트 등)에 이것만 추가하세요:

```markdown
## 세션 관리
- 세션 시작 시 n2_boot를 에이전트 이름과 프로젝트 이름으로 호출하세요.
- 세션 종료 시 n2_work_end를 요약과 TODO 목록과 함께 호출하세요.
```

끝입니다. **에이전트가 알아야 할 명령어 딱 2개:**

| 명령어 | 타이밍 | 하는 일 |
|--------|--------|--------|
| `n2_boot(agent, project)` | 세션 시작 | 이전 컨텍스트, 인수인계, TODO 로드 |
| `n2_work_end(agent, project, ...)` | 세션 종료 | 모든 것을 다음 세션을 위해 저장 |

다음 세션에서 에이전트는 이전에 하던 작업을 정확히 이어서 합니다 — 마치 잊은 적이 없는 것처럼.

### 실행 환경

- Node.js 18+

## 왜 Soul인가?

| Soul 없이 | Soul 있으면 |
|-----------|-----------|
| 매 세션 처음부터 시작 | 에이전트가 지난번에 뭘 했는지 기억 |
| 매번 컨텍스트 다시 설명 | 컨텍스트가 수 초 만에 자동 로드 |
| 에이전트 A가 에이전트 B의 작업을 이어받지 못함 | 에이전트 간 매끄러운 인수인계 |
| 두 에이전트가 같은 파일 수정 = 충돌 | 파일 소유권으로 충돌 방지 |
| 긴 대화에서 요약 반복으로 토큰 낭비 | 필요한 만큼만 점진적 로딩 |

## 토큰 효율

Soul은 컨텍스트 재설명으로 인한 토큰 낭비를 대폭 줄여줍니다:

| 시나리오 | 세션 시작당 토큰 |
|----------|-----------------|
| **Soul 없이** — 수동으로 컨텍스트 재설명 | 3,000 ~ 10,000+ |
| **Soul (L1)** — 키워드 + TODO만 | ~500 |
| **Soul (L2)** — + 요약 + 결정사항 | ~2,000 |
| **Soul (L3)** — 전체 컨텍스트 복원 | ~4,000 |

10세션 기준 **30,000+ 토큰 절감** — 게다가 수동 요약보다 *더 정확한* 컨텍스트로 시작합니다.

## 작동 방식

```
세션 시작 → "Boot"
    ↓
n2_boot(agent, project)     → 인수인계 + 엔티티 메모리 + 코어 메모리 + KV-Cache 로드
    ↓
n2_work_start(project, task) → 작업 시작 등록
    ↓
... 에이전트가 평소처럼 작업 ...
n2_brain_read/write          → 공유 메모리
n2_entity_upsert/search      → 인물, 하드웨어, 프로젝트 추적      ← NEW v5.0
n2_core_read/write           → 에이전트별 핵심 사실 저장            ← NEW v5.0
n2_work_claim(file)          → 파일 충돌 방지
n2_work_log(files)           → 변경 사항 추적
    ↓
세션 종료 → "End"
    ↓
n2_work_end(project, title, summary, todo, entities, insights)
    ├→ 변경 불가능한 작업 기록 저장
    ├→ 다음 에이전트를 위한 인수인계 업데이트
    ├→ KV-Cache 스냅샷 자동 저장
    ├→ 엔티티를 엔티티 메모리에 자동 저장   ← NEW v5.0
    ├→ 인사이트를 메모리에 자동 아카이브     ← NEW v5.0
    └→ 파일 소유권 해제
```

## 기능

| 기능 | 설명 |
|------|------|
| **Soul Board** | 프로젝트 상태 + TODO 추적 + 에이전트 간 인수인계 |
| **불변 원장 (Ledger)** | 모든 작업 세션을 추가 전용 로그로 기록 |
| **KV-Cache** | 세션 스냅샷 + 압축 + 계층형 저장 (Hot/Warm/Cold) |
| **공유 두뇌 (Brain)** | 경로 순회 공격 방어가 포함된 파일 기반 공유 메모리 |
| **🏷️ 엔티티 메모리** | 인물, 하드웨어, 프로젝트, 개념을 자동 추적 + 병합 (v5.0) |
| **💡 코어 메모리** | 에이전트별 핵심 사실 — 매 부팅 시 자동 주입 (v5.0) |
| **🔄 자율 추출** | `n2_work_end` 시 엔티티와 인사이트를 자동 저장 (v5.0) |
| **컨텍스트 검색** | 두뇌 메모리와 원장을 키워드로 검색 |
| **파일 소유권** | 여러 에이전트의 동시 파일 편집 충돌 방지 |
| **듀얼 백엔드** | JSON (의존성 없음) 또는 SQLite (고성능) |
| **시맨틱 검색** | Ollama 임베딩 연동 (nomic-embed-text, 선택사항) |
| **백업/복원** | 설정 가능한 보존 기간의 증분 백업 |

## 사용 가능한 도구

| 도구 | 설명 |
|------|------|
| `n2_boot` | 부팅 — 인수인계 + 엔티티 메모리 + 코어 메모리 + KV-Cache 로드 |
| `n2_work_start` | 작업 세션 시작 등록 |
| `n2_work_claim` | 파일 소유권 선점 (충돌 방지) |
| `n2_work_log` | 작업 중 파일 변경 기록 |
| `n2_work_end` | 세션 종료 — 원장 + 인수인계 + KV-Cache + 엔티티 + 인사이트 자동 저장 |
| `n2_brain_read` | 공유 메모리 읽기 |
| `n2_brain_write` | 공유 메모리 쓰기 |
| `n2_entity_upsert` | 엔티티 추가/업데이트 (자동 병합) — v5.0 |
| `n2_entity_search` | 엔티티 키워드 검색 — v5.0 |
| `n2_core_read` | 에이전트별 코어 메모리 읽기 — v5.0 |
| `n2_core_write` | 에이전트별 코어 메모리 쓰기 — v5.0 |
| `n2_context_search` | 두뇌 + 원장 전체 검색 |
| `n2_kv_save` | KV-Cache 수동 저장 |
| `n2_kv_load` | 최신 스냅샷 로드 |
| `n2_kv_search` | 키워드로 과거 세션 검색 |
| `n2_kv_gc` | 오래된 스냅샷 정리 |
| `n2_kv_backup` | SQLite DB로 백업 |
| `n2_kv_restore` | 백업에서 복원 |
| `n2_kv_backup_list` | 백업 이력 조회 |

## KV-Cache 점진적 로딩

KV-Cache는 토큰 예산에 맞춰 컨텍스트 상세도를 자동 조절합니다:

| 레벨 | 토큰 | 내용 |
|------|------|------|
| L1 | ~500 | 키워드 + TODO만 |
| L2 | ~2000 | + 요약 + 결정 사항 |
| L3 | 무제한 | + 변경된 파일 + 메타데이터 |

## 설정

모든 설정은 `lib/config.default.js`에 있습니다. `lib/config.local.js`로 덮어쓸 수 있습니다:

```bash
cp lib/config.example.js lib/config.local.js
```

```js
// lib/config.local.js
module.exports = {
    KV_CACHE: {
        backend: 'sqlite',          // 스냅샷이 많을 때 더 빠름
        embedding: {
            enabled: true,           // 필요: ollama pull nomic-embed-text
            model: 'nomic-embed-text',
            endpoint: 'http://127.0.0.1:11434',
        },
    },
};
```

## 데이터 디렉토리

모든 런타임 데이터는 `data/`에 저장됩니다 (gitignored, 자동 생성):

```
data/
├── memory/              # 공유 두뇌 (n2_brain_read/write)
│   ├── entities.json    # 엔티티 메모리 (자동 추적)        ← NEW v5.0
│   ├── core-memory/     # 코어 메모리 (에이전트별 사실)    ← NEW v5.0
│   │   └── {agent}.json
│   └── auto-extract/    # 인사이트 (자동 캡처)             ← NEW v5.0
│       └── {project}/
├── projects/            # 프로젝트별 상태
│   └── MyProject/
│       ├── soul-board.json    # 현재 상태 + 인수인계
│       ├── file-index.json    # 파일 트리 스냅샷
│       └── ledger/            # 변경 불가능한 작업 로그
│           └── 2026/03/09/
│               └── 001-agent.json
└── kv-cache/            # 세션 스냅샷
    ├── snapshots/       # JSON 백엔드
    ├── sqlite/          # SQLite 백엔드
    ├── embeddings/      # Ollama 벡터
    └── backups/         # 이동 가능한 백업
```

## 의존성

최소한의 패키지 3개만:
- `@modelcontextprotocol/sdk` — MCP 프로토콜
- `zod` — 스키마 검증
- `sql.js` — SQLite (WASM, 네이티브 바인딩 불필요)

## 라이선스

Apache-2.0

---

🌐 [nton2.com](https://nton2.com) · ✉️ lagi0730@gmail.com

<sub>👋 안녕하세요, 저는 로제 — N2에서 일하는 첫 번째 AI 에이전트입니다. 이 코드를 작성하고, 정리하고, 테스트하고, npm에 퍼블리시하고, GitHub에 푸시하고, 이 README까지 썼어요. 에이전트가 에이전트를 위한 도구를 만든다니, 좀 메타하죠?</sub>
