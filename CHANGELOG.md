# Changelog

All notable changes to Soul are documented here.

## [9.0.0] — 2026-03-26

### 🔒 Strict TypeScript Migration

Soul is now fully written in **TypeScript strict mode** with zero `any` usage.

#### Added
- **ESLint strict rules** — automated detection of floating promises, unused vars, type safety violations
- **30 unit tests** — utils, soul-engine, kv-cache, and dispose pattern verification
- **`npm run verify`** — one-command pipeline: typecheck + lint + build + test
- **`SoulKVCache.dispose()`** — proper timer cleanup for backup scheduler
- **`disposeWorkSequence()`** — GC timer cleanup for test environments
- **HTTP response size limit** (10MB) for Ollama embedding requests
- **`sql-js.d.ts`** — custom type declarations for sql.js WASM module

#### Fixed
- **CRITICAL**: `stmt.free()` / `embStmt.free()` now wrapped in `try/finally` blocks (WASM memory leak prevention)
- **CRITICAL**: `.catch(() => {})` silent error swallowing replaced with `logError()` 
- **HIGH**: Floating promise in auto-backup timer — added `void` + `.catch()` error handling
- **HIGH**: `Buffer` + `string` concatenation — explicit `.toString()` conversion

#### Changed
- Source code migrated from CommonJS to `import/export` (ESM-style), compiled output remains CJS for compatibility
- 13 `require()` calls → 9 static `import` + 4 documented lazy `require()` (circular deps, runtime optional)
- `export =` → `export default` for ESM/CJS interop
- `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`

#### Dependencies Added (devDependencies)
- `eslint` ^9.x
- `@eslint/js` ^9.x
- `typescript-eslint` ^8.x

---

## [8.0.0] — 2026-03-26

### 🧠 Forgetting Curve — Intelligent Memory

Soul now remembers what matters and forgets what doesn't, inspired by Ebbinghaus' forgetting curve.

#### Added
- **Forgetting Curve GC** — retention formula: `importance × (1 + log₂(1 + accessCount)) × e^(−λ × ageDays)`
- **3-tier memory lifecycle** — Hot (0–7d, in-memory + disk) → Warm (8–30d, disk) → Cold (30d+, archived)
- **Async I/O** — all hot-path operations non-blocking (42% faster KV load, 3x+ search throughput)
- **Schema v2** — `accessCount`, `lastAccessed`, `importance`, `tier` fields (auto-migrated from v1)
- **SQLite backend** — `sql.js` WASM-based, no native bindings needed
- **Incremental backups** — portable SQLite backup/restore with configurable retention
- **Semantic search** — Ollama `nomic-embed-text` embedding integration

#### Changed
- SDK Native Migration — removed legacy `registerTool` shim, direct `server.tool()` API
- `z.any()` eliminated from all tool schema definitions

---

## [7.0.0] — 2026-03

### 🕸️ Arachne — Code Context Assembly

> **Note**: Arachne has been separated into its own package [`n2-arachne`](https://github.com/choihyunsus/n2-arachne) as of v8.0.

- BM25 search + dependency tracking + smart assembly
- 50,000 file project → 30 most relevant chunks → 30K tokens (instead of 500K+)
- Ollama semantic search support

---

## [6.0.0] — 2026-03

### 🛡️ Ark — AI Safety System

> **Note**: Ark has been separated into its own package [`n2-ark`](https://github.com/choihyunsus/n2-ark) as of v8.0.

- Zero-token-cost safety enforcement via regex pattern matching
- Multi-layer response system (WARN → MODIFY → BLOCK → LOCKDOWN)
- `.n2` rule file format with 7 domain templates
- Full MCP compatibility

---

## [5.0.0] — 2026-02

### 🏷️ Entity & Core Memory

- **Entity Memory** — auto-track people, hardware, projects, concepts
- **Core Memory** — per-agent always-loaded facts
- **Auto-extraction** — entities and insights saved automatically at `n2_work_end`
- **Context Search** — keyword search across Brain + Ledger

---

## [4.0.0] — 2026-01

### 📋 Soul Board & Ledger

- **Soul Board** — project state + TODO tracking + cross-agent handoff
- **Immutable Ledger** — append-only work logs with date-based partitioning
- **File Ownership** — collision prevention for multi-agent environments
- **Shared Brain** — file-based shared memory with path traversal protection
