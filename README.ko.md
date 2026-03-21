🇬🇧 [English](README.md)

# 🧠 Soul

**AI 에이전트는 세션이 끝나면 모든 걸 잊어버립니다. Soul이 그걸 해결합니다.**
**AI 에이전트가 위험한 행동을 할 수도 있습니다. Ark가 그걸 막습니다.**
**AI 에이전트가 관련 없는 코드를 읽느라 토큰을 낭비합니다. Arachne가 그걸 해결합니다.**

> ### 🚀 v7.0 업데이트 — Arachne
>
> **Arachne** — 코드 컨텍스트 어셈블리 엔진. 코드베이스 전체를 인덱싱하고 AI에게 **정확히** 필요한 것만 전달합니다.
> ```
> 50,000 파일 프로젝트 → 가장 관련 있는 30개 청크 → 30K 토큰 (500K+ 대신)
> ```
> BM25 검색 + 의존성 추적 + 스마트 어셈블리. Ollama를 통한 시맨틱 검색도 지원. [자세히 →](#arachne--최고의-직조사)
>
> **Ark** (v6.0) 포함 — 토큰 비용 0으로 위험한 행동을 차단하는 AI 안전 시스템. [자세히 →](#ark--최후의-방패)

Cursor, VS Code Copilot 등 MCP 호환 AI 에이전트와 새 채팅을 시작할 때마다, 에이전트는 이전에 뭘 했는지 전혀 모른 채 처음부터 시작합니다. Soul은 에이전트에게 이런 능력을 부여하는 MCP 서버입니다:

- 🧠 **영구 기억** — 세션이 끝나도 기억이 유지됩니다
- 🤝 **인수인계** — 한 에이전트가 다른 에이전트의 작업을 이어받을 수 있습니다
- 📝 **작업 이력** — 모든 작업이 변경 불가능한 로그로 기록됩니다
- 🗂️ **공유 두뇌** — 여러 에이전트가 같은 컨텍스트를 읽고 쓸 수 있습니다
- 🏷️ **엔티티 메모리** — 인물, 하드웨어, 프로젝트를 자동 추적합니다 (v5.0)
- 💡 **코어 메모리** — 에이전트별 핵심 사실이 항상 로드됩니다 (v5.0)
- 🛡️ **Ark** — 토큰 비용 0으로 위험한 행동을 차단하는 AI 안전 시스템 (v6.0)
- 🕸️ **Arachne** — AI에게 정확히 필요한 코드만 전달하는 코드 컨텍스트 엔진 (v7.0)

> ⚡ **Soul은 N2 Browser의 작은 부속품 하나입니다** — 우리가 만들고 있는 AI 네이티브 브라우저의 일부예요. 멀티 에이전트 오케스트레이션, 실시간 도구 라우팅, 에이전트 간 통신 등 훨씬 더 많은 기능들이 현재 테스트 중입니다. 이건 시작에 불과합니다.

## 빠른 시작

### 1. 설치

**방법 A: npm (권장)**
```bash
npm install n2-soul
```

**방법 B: 소스에서 설치**
```bash
git clone https://github.com/choihyunsus/soul.git
cd soul
npm install
```

### 2. MCP 설정에 Soul 추가

Soul은 표준 MCP 서버(stdio)입니다. 사용 중인 호스트의 설정에 추가하세요:

<details>
<summary><strong>Cursor / VS Code Copilot / Claude Desktop</strong></summary>

`mcp.json`, `settings.json`, 또는 `claude_desktop_config.json`에 추가:
```json
{
  "mcpServers": {
    "soul": {
      "command": "node",
      "args": ["/path/to/node_modules/n2-soul/index.js"]
    }
  }
}
```
</details>

<details>
<summary><strong>🦙 Ollama + Open WebUI</strong></summary>

Open WebUI는 MCP 도구를 네이티브로 지원합니다.

```bash
# 1. Ollama 실행 확인
ollama serve

# 2. Soul 설치
npm install n2-soul

# 3. Soul 경로 확인
# Windows:
echo %cd%\node_modules\n2-soul\index.js
# Mac/Linux:
echo $(pwd)/node_modules/n2-soul/index.js
```

**Open WebUI**에서: **⚙️ 설정 → Tools → MCP Servers** → 새 서버 추가:
```
Name:    soul
Command: node
Args:    /your/path/to/node_modules/n2-soul/index.js
```

이제 Open WebUI에서 채팅하는 모든 모델이 Soul의 20개 이상의 메모리 도구를 사용할 수 있습니다.
</details>

<details>
<summary><strong>🖥️ LM Studio</strong></summary>

LM Studio는 MCP를 네이티브로 지원합니다. `~/.lmstudio/mcp.json`에 추가:
```json
{
  "mcpServers": {
    "soul": {
      "command": "node",
      "args": ["/path/to/node_modules/n2-soul/index.js"]
    }
  }
}
```
</details>

<details>
<summary><strong>🔧 기타 MCP 호환 호스트</strong></summary>

Soul은 **stdio** 위의 표준 MCP 프로토콜을 사용합니다. MCP를 지원하는 도구라면 Soul이 작동합니다. command를 `node`로, args를 `n2-soul/index.js` 경로로 지정하면 됩니다.
</details>

> **💡 팁:** npm으로 설치한 경우 경로는 `node_modules/n2-soul/index.js`입니다. 소스에서 설치한 경우 클론한 디렉토리의 절대 경로를 사용하세요.

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
| **Ark** | 토큰 비용 0으로 위험한 행동을 차단하는 AI 안전 시스템 (v6.0) |
| **🕸️ Arachne** | 🆕 코드 컨텍스트 어셈블리 — 코드베이스를 인덱싱하고 AI에게 필요한 것만 전달 (v7.0) |
| **☁️ 클라우드 저장** | 기억을 어디에든 저장 — Google Drive, NAS, 회사 서버, 아무 경로나 (v6.1) |

## ☁️ 클라우드 저장 — AI 기억을 원하는 곳 어디에든

![Cloud Storage](docs/cloud-storage.png)

> **설정 한 줄. API 키 없음. 월 요금 없음.**

Soul은 클라우드 저장에 대해 완전히 다른 접근법을 취합니다:

```js
// config.local.js — 이게 전부입니다
module.exports = {
    DATA_DIR: 'G:/내 드라이브/n2-soul',  // Google Drive
};
```

**끝입니다.** AI의 기억이 이제 클라우드에 있습니다. 모든 세션, 인수인계, 원장 기록이 Google Drive가 자동으로 동기화합니다. OAuth도, API 키도, SDK도 필요 없습니다.

### 작동 원리

Soul은 모든 걸 **일반 JSON 파일**로 저장합니다. OS가 읽을 수 있는 모든 폴더 = Soul의 클라우드. 클라우드 서비스가 동기화를 처리하고 — Soul은 자기가 "클라우드에 있는지"조차 모릅니다.

### 지원 저장소

| 저장소 | `DATA_DIR` 예시 | 비용 |
|--------|-----------------|:----:|
| 📁 **로컬** (기본값) | `./data` | 무료 |
| ☁️ **Google Drive** | `G:/내 드라이브/n2-soul` | 무료 (15GB) |
| ☁️ **OneDrive** | `C:/Users/you/OneDrive/n2-soul` | 무료 (5GB) |
| ☁️ **Dropbox** | `C:/Users/you/Dropbox/n2-soul` | 무료 (2GB) |
| 🖥️ **NAS** | `Z:/n2-soul` | 자체 장비 |
| 🏢 **회사 서버** | `\\\\server\\shared\\n2-soul` | 자체 인프라 |
| 🔌 **USB 드라이브** | `E:/n2-soul` | $10 |
| 🐧 **Linux (rclone)** | `~/gdrive/n2-soul` | 무료 |

### Soul 클라우드 특징

| 기능 | Soul |
|---|:---:|
| **클라우드 저장** | 설정 한 줄 |
| **월 비용** | **$0** |
| **설정 시간** | 10초 |
| **벤더 종속** | 없음 — 당신의 파일 |
| **데이터 소유권** | 100% 당신의 것 |
| **오프라인 작동** | 가능 |
| **자체 호스팅** | 아무 경로나 = 클라우드 |

### 팀 공유

여러 에이전트가 **같은 네트워크 경로**를 가리키면 = 즉석 공유 메모리:

```js
// 팀원 A                                // 팀원 B
DATA_DIR: '\\\\server\\team\\n2-soul'    DATA_DIR: '\\\\server\\team\\n2-soul'
// 같은 프로젝트 데이터, 공유 인수인계, 공유 두뇌!
```

### 왜 이게 되는가

> *"최고의 클라우드 연동은 연동이 아예 없는 것이다."*

Soul의 데이터는 **100% 일반 JSON 파일** — `soul-board.json`, 원장 기록, 두뇌 메모리. 폴더를 미러링하는 동기화 서비스(Google Drive, OneDrive, Dropbox, Syncthing, rsync)라면 뭐든 완벽하게 작동합니다. 데이터베이스 마이그레이션도, API 버전도, SDK 업데이트도 필요 없습니다. 그냥 파일입니다.

## 🧹 스토리지 관리 및 GC (가비지 컬렉션)

수백 번의 세션이 누적되면 파일 개수가 무한정 늘어나지 않을까요? Soul은 이 문제를 구조적으로 해결합니다:

### 1. KV-Cache 가비지 컬렉션 (`n2_kv_gc`)
Soul에는 오래된 스냅샷을 자동으로 정리하는 `n2_kv_gc` 도구가 내장되어 있습니다.
설정에서 `maxAgeDays`를 지정해두면, 에이전트가 주기적으로 불필요해진 과거 스냅샷을 삭제하여 용량을 관리합니다.

### 2. 날짜별 파티셔닝 구조 (Ledger)
절대 지워지지 않는 작업 기록(Ledger)은 거대한 단일 DB 파일이 아닙니다. `ledger/YYYY/MM/DD/` 형태로 날짜별로 완벽히 분리 저장됩니다.
작년 기록을 백업하고 싶다면 `2025` 폴더만 압축하면 끝입니다. 6개월 지난 로그를 지우고 싶다면 해당 폴더만 지우면 됩니다. DB 파일이 꼬일 걱정이 0%입니다.

### 3. OS 레벨 통제권
Soul의 데이터는 모두 '일반 파일'이므로, OS 기본 기능(크론탭, 윈도우 작업 스케줄러 등)으로 보존 주기 정책을 독립적으로 제어하기 매우 쉽습니다. 특정 프로젝트 데이터가 더 이상 필요 없다면 그냥 폴더를 통째로 지우세요. 보이지 않는 DB 찌꺼기가 남지 않습니다.

## Ark — 최후의 방패

![Ark Comic](docs/ark-comic.png)

노아의 방주처럼 — 대홍수에서 살아남는 최후의 보루.

### 왜 Ark인가?

| | Ark | LLM 기반 안전 | 임베딩 기반 |
|---|:---:|:---:|:---:|
| **토큰 비용** | 0 | 검사당 500~2,000 | 검사당 100~500 |
| **지연** | < 1ms | 1~5초 | 200~500ms |
| **추가 의존성** | 0 (순수 JS) | LLM API 키 필요 | 벡터 DB 필요 |
| **오프라인 작동** | 가능 | 불가 | 경우에 따라 |
| **항상 활성화** | 필수 (토글 없음) | 선택적 | 선택적 |
| **자기보호** | 4계층 대응 | 없음 | 없음 |
| **규칙 형식** | `.n2` 파일 (사람이 읽을 수 있음) | 프롬프트 엔지니어링 | 임베딩 튜닝 |
| **업종별 템플릿** | 7개 도메인 포함 | 직접 작성 | 직접 작성 |
| **MCP 호환** | 모든 호스트 (Cursor, VS Code, Claude Desktop) | 호스트 한정 | 호스트 한정 |

### 토큰 비용: 0

**왜 0인가?** Ark는 AI 모델 안이 아니라 **MCP 서버 내부(Node.js)에서** 실행되기 때문입니다.

```
┌───────────────────────────────────────┐
│           LLM (클라우드)              │
│    AI 에이전트가 도구 호출 생성      │
│       (토큰이 사용되는 곳)           │
└───────────────────┬───────────────────┘
                    │ 도구 호출
                    ▼
┌───────────────────────────────────────┐
│    MCP 서버 (Node.js, 로컬)         │
│                                       │
│   ark.check() ← 순수 정규식, 여기서 실행 │
│   < 1ms         네트워크/LLM/토큰 없음  │
│                                       │
│   통과? ─No─▶ "BLOCKED" 텍스트 반환    │
│     │                                 │
│    Yes ─▶ 핸들러 실행                  │
└───────────────────────────────────────┘
```

핵심: **토큰 비용은 LLM 내부에서만 발생**합니다. Ark는 한 단계 아래 — 서버 레벨에 있습니다. LLM이 도구 호출을 보내면, Ark가 핸들러 실행 전에 정규식으로 검사합니다. 두 번째 LLM 호출 없음, API 요청 없음, 벡터 검색 없음. 그냥 문자열 매칭.

세션당 100회 도구 호출 기준, LLM 기반 안전 대비 **50,000~200,000 토큰 절감**.

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
| `n2_arachne` | 🆕 코드 컨텍스트: 인덱싱, 검색, 어셈블, 백업, 상태 (v7.0) |

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

### 보안 철학

**`.n2` 규칙의 투명성**: 안전 규칙은 **의도적으로 공개 + 감사 가능**하도록 설계되었습니다. 숨겨진 규칙, 난독화된 패턴, "우리를 믿어라" 블랙박스가 없습니다. 사용자가 직접 읽고 커스터마이즈하고 검증할 수 있어야 합니다.

**시크릿은 로컬만**: `config.local.js`는 gitignore 처리되어 배포되지 않습니다. 사용자의 머신에만 존재합니다. Soul은 API 키, 비밀번호, 인증 정보를 전송/저장/처리하지 않습니다.

**저장소 주권**: 모든 데이터(원장, 메모리, 감사 로그)는 **당신의 머신**에 남습니다. 백업 위치 선택은 자유 — 로컬 SQLite, Google Drive 폴더, 자체 클라우드 어디든. Soul은 외부로 통신하지 않습니다.

## 데이터 디렉토리

모든 런타임 데이터는 `data/`에 저장됩니다 (gitignored, 자동 생성):

```
soul/
├── rules/              # Ark 안전 규칙 (활성)               ← v6.0
│   └── default.n2          # 기본 규칙셋 (125개 패턴)
├── lib/
│   ├── ark/            # Ark 코어 엔진                     ← v6.0
│   │   ├── index.js        # createArk() 팩토리
│   │   ├── gate.js         # SafetyGate 엔진
│   │   ├── parser.js       # .n2 규칙 파서
│   │   ├── audit.js        # 감사 로거
│   │   └── examples/       # 업종별 규칙 템플릿
│   └── arachne/        # Arachne 코드 컨텍스트 엔진        ← NEW v7.0
│       ├── index.js        # createArachne() 팩토리
│       ├── indexer.js      # 파일 스캐너 + 증분 인덱싱
│       ├── chunker.js      # 언어 인식 코드 청킹
│       ├── search.js       # BM25 검색 엔진
│       ├── assembler.js    # 토큰 예산 기반 컨텍스트 어셈블리
│       ├── store.js        # SQLite 저장 (sql.js)
│       └── ignore.js       # .gitignore + .contextignore 지원
├── data/
│   ├── memory/              # 공유 두뇌 (n2_brain_read/write)
│   │   ├── entities.json    # 엔티티 메모리 (자동 추적)
│   │   ├── core-memory/     # 코어 메모리 (에이전트별)
│   │   │   └── {agent}.json
│   │   └── auto-extract/    # 인사이트 (자동 캡처)
│   │       └── {project}/
│   ├── projects/            # 프로젝트별 상태
│   │   └── MyProject/
│   │       ├── soul-board.json    # 현재 상태 + 인수인계
│   │       ├── file-index.json    # 파일 트리 스냅샷
│   │       └── ledger/            # 변경 불가능한 작업 로그
│   │           └── 2026/03/09/
│   │               └── 001-agent.json
│   ├── ark-audit/           # Ark 차단/통과 로그          ← v6.0
│   ├── arachne/             # Arachne 인덱스 DB + 임베딩  ← NEW v7.0
│   └── kv-cache/            # 세션 스냅샷
│       ├── snapshots/       # JSON 백엔드
│       ├── sqlite/          # SQLite 백엔드
│       ├── embeddings/      # Ollama 벡터
│       └── backups/         # 이동 가능한 백업
```

## 의존성

최소한의 패키지 3개만:
- `@modelcontextprotocol/sdk` — MCP 프로토콜
- `zod` — 스키마 검증
- `sql.js` — SQLite (WASM, 네이티브 바인딩 불필요)

## 라이선스

Apache-2.0

## 💖 스폰서

Soul은 무료 오픈소스입니다. 이 멋진 분들이 Soul을 살아있게 해줍니다:

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/sunir">
        <img src="https://github.com/sunir.png" width="80" height="80" style="border-radius:50%;" alt="Sunir Shah" /><br />
        <sub><b>Sunir Shah</b></sub>
      </a><br />
      <sub>🥇 첫 번째 스폰서</sub>
    </td>
  </tr>
</table>

> 스폰서가 되어주세요 → [GitHub Sponsors](https://github.com/sponsors/choihyunsus)

---

🌐 [nton2.com](https://nton2.com) · ✉️ lagi0730@gmail.com

<sub>👋 안녕하세요, 저는 로제 — N2에서 일하는 첫 번째 AI 에이전트입니다. 이 코드를 작성하고, 정리하고, 테스트하고, npm에 퍼블리시하고, GitHub에 푸시하고, 이 README까지 썼어요. 에이전트가 에이전트를 위한 도구를 만든다니, 좀 메타하죠?</sub>
