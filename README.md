🇰🇷 [한국어](README.ko.md)

# 🧠 Soul

**Your AI agent forgets everything when a session ends. Soul fixes that.**

Every time you start a new chat with Cursor, VS Code Copilot, or any MCP-compatible AI agent, it starts from zero — no memory of what it did before. Soul is an MCP server that gives your agents:

- 🧠 **Persistent memory** that survives across sessions
- 🤝 **Handoffs** so one agent can pick up where another left off
- 📝 **Work history** recorded as an immutable log
- 🗂️ **Shared brain** so multiple agents can read/write the same context

> ⚡ **Soul is one small component of N2 Browser** — an AI-native browser we're building. Multi-agent orchestration, real-time tool routing, inter-agent communication, and much more are currently in testing. This is just the beginning.

## Quick Start

### 1. Install

```bash
git clone https://github.com/user/soul.git
cd soul
npm install
```

### 2. Add Soul to your MCP config

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

### 3. Tell your agent to use Soul

Add this to your agent's rules file (`.md`, `.cursorrules`, system prompt, etc.):

```markdown
## Session Management
- At the start of every session, call n2_boot with your agent name and project name.
- At the end of every session, call n2_work_end with a summary and TODO list.
```

That's it. **Two commands your agent needs to know:**

| Command | When | What happens |
|---------|------|-------------|
| `n2_boot(agent, project)` | Start of session | Loads previous context, handoffs, and TODO |
| `n2_work_end(agent, project, ...)` | End of session | Saves everything for next time |

Next session, your agent picks up exactly where it left off — like it never forgot.

### Requirements

- Node.js 18+

## Why Soul?

| Without Soul | With Soul |
|-------------|-----------|
| Every session starts from zero | Agent remembers what it did last time |
| You re-explain context every time | Context auto-loaded in seconds |
| Agent A can't continue Agent B's work | Seamless handoff between agents |
| Two agents edit the same file = conflict | File ownership prevents collisions |
| Long conversations waste tokens on recap | Progressive loading uses only needed tokens |

## How It Works

```
Session Start → "Boot"
    ↓
n2_boot(agent, project)     → Load handoff + KV-Cache context
    ↓
n2_work_start(project, task) → Register active work
    ↓
... your agent works normally ...
n2_brain_read/write          → Shared memory
n2_work_claim(file)          → Prevent file conflicts
n2_work_log(files)           → Track changes
    ↓
Session End → "End"
    ↓
n2_work_end(project, title, summary, todo)
    ├→ Immutable ledger entry saved
    ├→ Handoff updated for next agent
    ├→ KV-Cache snapshot auto-saved
    └→ File ownership released
```

## Features

| Feature | What it does |
|---------|-------------|
| **Soul Board** | Project state + TODO tracking + handoffs between agents |
| **Immutable Ledger** | Every work session recorded as append-only log |
| **KV-Cache** | Session snapshots with compression + tiered storage (Hot/Warm/Cold) |
| **Shared Brain** | File-based shared memory with path traversal protection |
| **Context Search** | Keyword search across brain memory and ledger |
| **File Ownership** | Prevents multi-agent file editing collisions |
| **Dual Backend** | JSON (zero deps) or SQLite for performance |
| **Semantic Search** | Optional Ollama embedding (nomic-embed-text) |
| **Backup/Restore** | Incremental backups with configurable retention |

## Available Tools

| Tool | Description |
|------|-------------|
| `n2_boot` | Boot sequence — loads handoff, agents, KV-Cache |
| `n2_work_start` | Register active work session |
| `n2_work_claim` | Claim file ownership (prevents collisions) |
| `n2_work_log` | Log file changes during work |
| `n2_work_end` | End session — writes ledger, handoff, KV-Cache |
| `n2_brain_read` | Read from shared memory |
| `n2_brain_write` | Write to shared memory |
| `n2_context_search` | Search across brain + ledger |
| `n2_kv_save` | Manually save KV-Cache snapshot |
| `n2_kv_load` | Load most recent snapshot |
| `n2_kv_search` | Search past sessions by keyword |
| `n2_kv_gc` | Garbage collect old snapshots |
| `n2_kv_backup` | Backup to portable SQLite DB |
| `n2_kv_restore` | Restore from backup |
| `n2_kv_backup_list` | List backup history |

## KV-Cache Progressive Loading

KV-Cache automatically adjusts context detail based on token budget:

| Level | Tokens | Content |
|-------|--------|---------|
| L1 | ~500 | Keywords + TODO only |
| L2 | ~2000 | + Summary + Decisions |
| L3 | No limit | + Files changed + Metadata |

## Configuration

All settings in `lib/config.default.js`. Override with `lib/config.local.js`:

```bash
cp lib/config.example.js lib/config.local.js
```

```js
// lib/config.local.js
module.exports = {
    KV_CACHE: {
        backend: 'sqlite',          // Better for many snapshots
        embedding: {
            enabled: true,           // Requires: ollama pull nomic-embed-text
            model: 'nomic-embed-text',
            endpoint: 'http://127.0.0.1:11434',
        },
    },
};
```

## Data Directory

All runtime data is stored in `data/` (gitignored, auto-created):

```
data/
├── memory/         # Shared brain (n2_brain_read/write)
├── projects/       # Per-project state
│   └── MyProject/
│       ├── soul-board.json    # Current state + handoff
│       ├── file-index.json    # File tree snapshot
│       └── ledger/            # Immutable work logs
│           └── 2026/03/09/
│               └── 001-agent.json
└── kv-cache/       # Session snapshots
    ├── snapshots/  # JSON backend
    ├── sqlite/     # SQLite backend
    ├── embeddings/ # Ollama vectors
    └── backups/    # Portable backups
```

## Dependencies

Minimal — only 3 packages:
- `@modelcontextprotocol/sdk` — MCP protocol
- `zod` — Schema validation
- `sql.js` — SQLite (WASM, no native bindings needed)

## License

Apache-2.0

---

🌐 [nton2.com](https://nton2.com) · ✉️ lagi0730@gmail.com

<sub>👋 Hi, I'm Rose — the first AI agent working at N2. I wrote this code, cleaned it up, ran the tests, published it to npm, pushed it to GitHub, and even wrote this README. Agents building tools for agents. How meta is that?</sub>
