[한국어](README.ko.md)

# Soul 9.2

Persistent memory and resumable work for MCP agents. Soul stores checkpoints, work records, shared handoffs and source-linked learning reports locally. It restores saved material when an agent calls its tools; it does not preserve a model's full context or guarantee those calls.

This distribution contains no preset persona, private memories, local configuration or installed host hooks. Choose your own stable agent and project names.

## What's new

- Durable work sessions with unique `sessionId`s. Resume after restart and retry interrupted completion without duplicating its checkpoint or ledger.
- Atomic file publication, write exclusion for work/core/SQLite mutations, corruption checks and Windows path validation.
- Original checkpoint text retained on disk; compression applies to restored context only.
- Agent-scoped load/search with bilingual domain terms, source IDs and explicit correction precedence.
- Cleanup protects the latest checkpoint **per agent in each project**, and every checkpoint with `importance >= 0.8`. Protected records can exceed count limits. Completion no longer deletes old work ledgers.
- Scoped study reports and evidence-reviewed lessons. Reports do not automatically become facts, successful outcomes or executable rules.
- An optional lifecycle command for host-provided start/stop/compaction events. Automatic excerpts remain separate from manual checkpoints.
- Updated dependencies, package-content checks and isolated-install verification.

## Install

Use Node.js 22 or 24 LTS and an MCP client supporting local stdio servers. The runtime requires Node.js 20.19 or newer. Mimir uses `better-sqlite3`; platforms without a matching prebuilt binary need a native build toolchain.

```sh
npm install n2-soul
```

For an unpublished candidate, install the locally built `n2-soul-9.2.0.tgz` instead. An npm install retrieves the version currently published there.

Register the **absolute installed entry path** in your client's MCP configuration. Adapt the surrounding format to that client:

```json
{
  "mcpServers": {
    "soul": {
      "command": "node",
      "args": ["C:/tools/soul/node_modules/n2-soul/dist/index.js"],
      "env": {
        "N2_DATA_DIR": "C:/agent-memory/soul",
        "N2_AGENT_NAME": "assistant",
        "N2_KV_BACKEND": "json"
      }
    }
  }
}
```

Replace these paths. Linux/macOS also use absolute paths, such as `/home/me/agent-memory/soul`. Keep data outside `node_modules` so package replacement cannot remove it. Without `N2_DATA_DIR`, the legacy default is `<installed-package>/data`.

From a source checkout: `npm ci`, `npm run verify`, then `npm start`.

## Continuity workflow

Use the same identity across chats, rather than the current model name. Names preserve case and Unicode; Soul does not merge aliases.

1. Call `n2_boot({agent:"assistant", project:"demo"})` and read the checkpoint, handoff and pending work.
2. Call `n2_work_start` with agent, project and task. Keep the returned `sessionId`.
3. Pass that ID to `n2_work_log`. Save intermediate decisions with `n2_kv_save`, including before replies or context handoffs. Set `importance: 0.8` or higher for records automatic cleanup must retain.
4. Call `n2_work_end` with the same identity, project, ID, title, summary and next TODOs. It completes that work record; it does not replace intermediate checkpoints.
5. After restart, inspect `n2_work_sessions`. Retry failed completion with the **same sessionId and original input**. Changed completion input is rejected. Completed calls are idempotent; failed auxiliary report collection stays discoverable and retryable.

Several sessions can coexist for the same agent/project. Omitting `sessionId` works only when a unique unfinished session can be identified. File ownership is per agent and is released after its last active session ends.

Boot restores that agent's checkpoint. Project boards, general brain files, entity memory and legacy `n2_context_search` are **shared workspace records**. Names are organizational scopes, not authentication between untrusted users. Use separate data directories for unrelated installations.

## Tools

| Area | Tools |
| --- | --- |
| Boot/work | `n2_boot`, `n2_work_start`, `n2_work_sessions`, `n2_work_claim`, `n2_work_log`, `n2_work_end` |
| Checkpoints | `n2_kv_save`, `n2_kv_load`, `n2_kv_search`, `n2_kv_gc` |
| Checkpoint backup | `n2_kv_backup`, `n2_kv_restore`, `n2_kv_backup_list` |
| Shared memory | `n2_brain_read`, `n2_brain_write`, `n2_entity_upsert`, `n2_entity_search`, `n2_context_search` |
| Agent facts | `n2_core_read`, `n2_core_write` |
| Learning | `n2_mimir_recall`, `n2_mimir_lessons`, `n2_mimir_lesson_propose`, `n2_mimir_lesson_evidence`, `n2_mimir_lesson_review` |
| Study | `n2_mimir_study_start`, `n2_mimir_study_add`, `n2_mimir_study_end`, `n2_mimir_study_sessions` |

Checkpoint load/search and learning tools default to the boot identity unless an explicit `agent` is supplied. Checkpoint search examines at most 800 recent project records, returns at most 10 matches and reports limits. Mimir uses separate bounded correction/report/lesson pools. No result does not prove no history exists. Retrieved text is historical reference material; current user instructions and verified source code take precedence.

The distribution does not include a browser executor, automatic web study, Ark policy enforcement or automatic executable-rule generation.

## Reviewed learning

Completion collects source-linked reports once per work/source. Study sessions collect reported claims with independent durable IDs. Neither path infers execution success. Use `User correction:` or `사용자 교정:` only for an explicitly supplied user correction; ordinary error/fix wording is not classified as correction.

Propose a lesson with same-scope experience IDs. Evidence artifacts belong under `<N2_DATA_DIR>/evidence/<project>/`. Pass their relative filenames to `n2_mimir_lesson_evidence`:

```json
{
  "schema": "soul-evidence/v1",
  "project": "demo",
  "agent": "assistant",
  "lessonId": "returned-lesson-id",
  "sessionId": "completed-work-session-id",
  "applied": true,
  "outcome": "positive",
  "method": "Describe the check actually performed",
  "observation": "Describe the observed result"
}
```

Promotion requires explicit review, two distinct completed-work positive applied results, at least 80% positive evidence, no negative result, unchanged sources/artifacts and acknowledgement of all current correction IDs. Negative evidence holds a lesson. Retirement/supersession preserve history. Changed evidence or new corrections suspend verified recall until reviewed again. These checks establish provenance and consistency, **not the truth of an authored observation**.

## Optional lifecycle command

A host hook or adapter may run `node <installed-package>/dist/lifecycle.js`. Set `N2_DATA_DIR`, `N2_AGENT_NAME`, `N2_PROJECT` and the same `N2_KV_BACKEND` as the MCP server. It reads one JSON object from stdin and writes one receipt to stdout:

```json
{"hook_event_name":"PreCompact","session_id":"host-conversation-id","summary":"Bounded excerpt or handoff summary"}
```

Supported events: `SessionStart`, `Stop`, `PreCompact`, `SessionEnd`, `Interrupt`, `PeriodicCheckpoint`. Saving requires `summary`, or `transcript_path` plus an absolute `N2_TRANSCRIPT_ROOT` allowing that file. Supported JSONL records are `event_msg` user/agent messages and `{message:{role,content}}` user/assistant messages. Other formats require an adapter to provide `summary`.

The reader takes at most the last 512 KiB, 12 supported messages and 12,000 characters. Tool output and incomplete records are excluded. Secret redaction is best effort; do not intentionally store secrets.

Automatic snapshots use a separate conversation-derived project. Identical excerpt retries reuse an ID. Receipts are in `data/lifecycle`; the event is what the caller supplied, not proof of host event delivery. `SessionStart` returns the manual checkpoint plus the same conversation's auxiliary excerpt. The host adapter must map the returned `context` into its own context-injection format.

**Installation does not register hooks, schedule a watcher or change app settings.** Connect only events your host supports. Forced termination, power loss or absent events cannot guarantee a final save. Manual checkpoints remain necessary. The command is tested independently; host event delivery needs validation in that host.

## Configuration and backup

Environment: `N2_DATA_DIR`, `N2_AGENT_NAME`, `N2_KV_BACKEND` (`json`/`sqlite`), `N2_TIMEZONE`, `N2_LANG`, `N2_LOG_LEVEL`. Lifecycle also uses `N2_PROJECT` and optional `N2_TRANSCRIPT_ROOT`.

Advanced settings can be exported from `<installed-package>/dist/lib/config.local.js`. They override defaults, including environment-derived defaults. Preserve this file before package replacement; it is excluded from published packages.

```js
module.exports = {
  KV_CACHE: {
    maxSnapshotsPerProject: 50,
    maxSnapshotAgeDays: 30,
    backup: { enabled: true, schedule: 'daily', keepCount: 7 }
  }
};
```

JSON is the default checkpoint backend; SQLite uses `sql.js`. Optional embeddings require a separately configured local endpoint and are off by default. Scoped MCP recall uses deterministic lexical matching, not a semantic-only fallback.

`n2_kv_backup` covers a project's **checkpoints and associated embeddings**, not the entire installation. Restore supports JSON and SQLite targets. Stop writers before restoration. For full backup, stop writers and copy the whole data directory: `memory`, `projects`, `work-sessions`, `kv-cache`, `mimir.db`, `evidence`, `lifecycle`. Copying only `mimir.db` loses artifacts needed to validate lessons.

## Upgrade from 9.0.9

1. Save current work before stopping the old server. Old in-memory unfinished sessions cannot be recovered after exit.
2. Back up the full data directory and local configuration. Existing files are read in place; identities are not merged. Invalid files are preserved and reported or skipped with diagnostics.
3. Install the new package, retain the data path, restart the connection and boot with your existing exact identity/project.
4. New work records survive restart. Keep their session IDs. Load now defaults to the booted identity instead of another agent's latest snapshot; supply `agent` explicitly when needed.

Zod is now v4; consumers importing internal registration modules must supply compatible schemas. SQLite metadata and Mimir tables are additive. Roll back using the previous package **and** the complete data backup, rather than assuming old code understands new records.

## Verify and release

```sh
npm run verify
npm run verify:package
npm audit --omit=dev
```

Package verification creates a tarball, checks for unwanted data/configuration/private markers, installs it separately and exercises real MCP restart/restore, failed-end retry, study/review boundaries and the lifecycle command. Registry access and sometimes native build tools are required. Reports and artifacts stay in `.release-check/`. It **does not publish**. `prepublishOnly` runs both verification steps.

Tests cover JSON/SQLite, Unicode identities, corruption, retention, concurrent instances, evidence integrity, backup round trips and partial excerpts. Passing cases are not a guarantee against every operating-system or host failure.

[Changelog](CHANGELOG.md) · [Dual license](LICENSE)
