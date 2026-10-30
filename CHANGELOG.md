# Changelog

All notable changes to Soul are documented here.

## [9.2.0] — 2026-10-30

### Continuity and retention
- Persist work sessions with UUIDs; add `n2_work_sessions`, explicit work ownership and restart-safe completion retries with stable checkpoint/ledger IDs.
- Preserve original summaries. Protect latest-per-agent and importance >= 0.8 checkpoints during GC. Stop pruning ledgers as a completion side effect.
- Add atomic writes, corruption checks, safe path segments, Unicode core identities and cross-process write exclusion. Fix stale cache/SQLite instances and backend initialization before completion.
- Scope checkpoint load/search by exact agent and project; preserve identities without aliases. Add bounded bilingual lexical recall, correction precedence and source excerpts.
- Preserve backup metadata, honor custom storage paths, avoid rapid backup ID collisions and serialize backup creation.

### Reviewed learning and lifecycle
- Add scoped Mimir report receipts, durable study collection, lesson proposals, evidence artifacts and explicit reviews. No inferred execution success or generated executable policy.
- Require distinct completed-work evidence and review of current corrections before lesson promotion. Recheck source/artifact integrity on recall.
- Add an opt-in `dist/lifecycle.js` command for host-supplied start/stop/compaction events. Bounded, redacted excerpts live separately from manual checkpoints; no automatic host installation or watcher.
- Keep distribution free of preset personas, private records and local configuration.

### Distribution and compatibility
- Update MCP SDK and Zod (v4), refresh dependency lockfile, and require Node.js >=20.19. Existing internal-module consumers must use compatible Zod schemas.
- Rewrite English/Korean installation, migration, backup and lifecycle documentation, including current entry paths and honest continuity limits.
- Add isolated tarball install/MCP restart/retry validation and private-content checks to the prepublish gate.
- Old unfinished sessions existed only in RAM: finish/save them before stopping 9.0.9. Back up the complete data directory before upgrading or rolling back.

## [9.0.9] — 2026-04-02

- Restrict npm contents to compiled runtime and declaration files, excluding compiled tests.

## [9.0.7] — 2026-03-27

### PerfMonitor — Self-Tuning GC

Forgetting Curve GC now self-tunes based on actual query latency. When snapshots grow large enough to slow queries, retention tightens automatically — up to 3x reduction — without losing important history (Forgetting Curve scores still determine which snapshots survive).

#### Added
- **`PerfMonitor`** (`perf-monitor.ts`) — sliding-window latency tracker with p95 analysis
- **`getPerfSnapshot()`** — exposes avg/p95 latency and sample count for diagnostics
- **Auto-instrumented `load()` and `search()`** — every query records its latency
- **Perf-aware `gc()`** — uses PerfMonitor recommendations to auto-adjust `maxAgeDays` and `maxCount`
- **Config: `perfSlowMs` / `perfCriticalMs`** — configurable thresholds (defaults: 100ms / 500ms)

#### How It Works
```
Queries fast (p95 < 100ms)   → GC relaxed: keep 30 days, 50 snapshots
Queries slow (100ms ~ 500ms) → GC tightens: proportionally reduce retention
Queries critical (p95 > 500ms) → GC aggressive: 3x reduction (10 days, 16 snapshots)
```

#### Why This Matters
Community feedback (via ninadpathak): _"handoff chains quietly explode your db size after a week of real use."_ This update ties GC directly to performance reality — storage stays lean without manual intervention.

---



### StorageAdapter — Unified Backend Interface

Eliminated all B2 (unsafe cast) technical debt in the KV-Cache module by introducing a shared `StorageAdapter` interface.

#### Added
- **`StorageAdapter` interface** (`storage-adapter.ts`) — common contract for all storage backends (save, load, list, search, gc, touch, dispose)
- **`SqliteStore.touch()`** — Forgetting Curve access tracking for SQLite backend (previously only available in JSON backend)

#### Fixed
- **B2 BLOCKER**: `SqliteStore as unknown as SnapshotEngine` unsafe cast removed — both now implement `StorageAdapter`
- **B2 BLOCKER**: `engine as unknown as Record<string, boolean>` internal state hack removed — proper `init()` flow via interface
- **B2 BLOCKER**: `target as 'json' | 'sqlite'` in restore tool — replaced with runtime validation

#### Changed
- `SqliteStore` methods now `async` to match `StorageAdapter` contract (no behavior change — sql.js is synchronous internally)
- `TierManager` constructor accepts `StorageAdapter` instead of `SnapshotEngine` directly
- `SoulKVCache.snapshot` type changed from `SnapshotEngine | TierManager` to `StorageAdapter`
- Forgetting Curve `touch()` now called unconditionally (no more `'touch' in this.snapshot` runtime check)

#### Why This Matters
The `as unknown as` pattern breaks TypeScript's type safety guarantees — the compiler cannot verify correctness across the cast boundary. By introducing a shared interface, all three backends (SnapshotEngine, SqliteStore, TierManager) are now provably type-compatible at compile time.

---

## [9.0.2] — 2026-03-27

### Packaging Fix

#### Fixed
- **CRITICAL**: `.npmignore` excluded `dist/lib/`, `dist/sequences/`, `dist/tools/`, and `dist/index.js` — npm installs failed with `Cannot find module './lib/config'` ([#issue](https://github.com/choihyunsus/soul/issues))
- Root-anchored all ignore patterns with leading `/` so they no longer match inside `dist/`
- Removed compiled test files (`dist/tests/`) from the published tarball (88 files, down from 100)

---

## [9.0.0] — 2026-03-26

### Strict TypeScript Migration

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

### Forgetting Curve — Intelligent Memory

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

### Arachne — Code Context Assembly

> **Note**: Arachne has been separated into its own package [`n2-arachne`](https://github.com/choihyunsus/n2-arachne) as of v8.0.

- BM25 search + dependency tracking + smart assembly
- 50,000 file project → 30 most relevant chunks → 30K tokens (instead of 500K+)
- Ollama semantic search support

---

## [6.0.0] — 2026-03

### Ark — AI Safety System

> **Note**: Ark has been separated into its own package [`n2-ark`](https://github.com/choihyunsus/n2-ark) as of v8.0.

- Zero-token-cost safety enforcement via regex pattern matching
- Multi-layer response system (WARN → MODIFY → BLOCK → LOCKDOWN)
- `.n2` rule file format with 7 domain templates
- Full MCP compatibility

---

## [5.0.0] — 2026-02

### Entity & Core Memory

- **Entity Memory** — auto-track people, hardware, projects, concepts
- **Core Memory** — per-agent always-loaded facts
- **Auto-extraction** — entities and insights saved automatically at `n2_work_end`
- **Context Search** — keyword search across Brain + Ledger

---

## [4.0.0] — 2026-01

### Soul Board & Ledger

- **Soul Board** — project state + TODO tracking + cross-agent handoff
- **Immutable Ledger** — append-only work logs with date-based partitioning
- **File Ownership** — collision prevention for multi-agent environments
- **Shared Brain** — file-based shared memory with path traversal protection
