# Soul — The Memory System That Makes AI Agents Actually Useful

## The Problem Nobody Talks About

Every time you open a new chat with Cursor, VS Code Copilot, Claude, or any AI coding assistant, your agent starts from absolute zero. It doesn't know what you worked on yesterday. It doesn't know what files it changed. It doesn't remember the bug it found 3 hours ago. It's like having a brilliant developer with permanent amnesia.

You end up spending the first 5-10 minutes of every session re-explaining context. "Remember the auth module? The one with JWT? We added rate limiting yesterday..." — and the agent has no idea.

**This is the single biggest productivity killer in AI-assisted development today.** Not model intelligence. Not context window size. Memory loss.

## What Soul Does

Soul is an open-source MCP (Model Context Protocol) server that gives AI agents persistent memory. Install it once, and your agents remember everything — across sessions, across agents, across days.

### The Magic: Two Commands

```
Session start: n2_boot("rose", "my-project")  → Agent loads all previous context
Session end:   n2_work_end(...)                → Agent saves everything for next time
```

That's it. Next session, your agent picks up exactly where it left off.

## Key Features That Make Soul Special

### 1. Persistent Memory (KV-Cache)
Every session is automatically saved as a snapshot. When you start a new session, Soul loads the previous context using progressive levels:
- **L1 (~500 tokens)**: Just keywords and TODO — ultra-fast startup
- **L2 (~2,000 tokens)**: Summary + decisions + context
- **L3 (full)**: Complete session restore

This means over 10 sessions, you save 30,000+ tokens on context alone.

### 2. Multi-Agent Handoffs
Agent Rose works on the auth module at 2pm. Agent Jenny picks up at 5pm. With Soul, Jenny knows exactly what Rose did, what's left to do, and what files were changed. No re-explanation needed.

### 3. Entity Memory (v5.0)
Soul automatically tracks people, hardware, projects, and concepts across sessions. Every entity is stored with attributes and auto-merged when updated.

### 4. Core Memory (v5.0)
Agent-specific facts that are always loaded at boot. An agent's identity, working rules, current focus — always available, never forgotten.

### 5. Shared Brain
Multiple agents can read and write to the same shared memory space. File-based, simple, with path traversal protection built in.

### 6. Immutable Ledger
Every work session is recorded as an append-only log. You can trace exactly what happened, when, and by whom.

### 7. File Ownership
Prevents two agents from editing the same file simultaneously. Simple, effective collision prevention.

## Ark — Built-in AI Safety (v6.0)

This is the feature that got people really excited on Reddit.

### The Problem
AI agents with tool access can execute dangerous commands. `rm -rf /` to delete everything. `DROP DATABASE` to destroy data. `git push --force` to rewrite history. These aren't hypothetical — autonomous agents have already done these things.

### Ark's Solution: Zero-Token Safety

Most AI safety solutions use another LLM to check if an action is safe. That costs 500-2,000 tokens per check and takes 1-5 seconds.

**Ark uses pure regex pattern matching inside the MCP server.** Zero tokens. Less than 1 millisecond. Always on — there's no toggle to disable it. It's like a firewall for your AI.

Key properties:
- **Zero token cost** — runs in Node.js, not in the LLM
- **Zero latency** — microsecond execution
- **Always on** — no `enabled: false` option (by design)
- **Self-protecting** — 4 layers prevent a rogue AI from disabling Ark itself
- **Human-readable rules** — `.n2` files anyone can read and customize
- **7 industry templates** — Medical (HIPAA), Military, Finance, Legal, Privacy (GDPR), Autonomous, DevOps

### .n2 Rule Files

Safety rules are written in a human-readable format:

```
@rule catastrophic_destruction {
    scope: all
    blacklist: [/rm\s+-rf/, /DROP\s+DATABASE/i, /git\s+push\s+--force/i]
    requires: human_approval
}
```

Transparent, auditable, customizable. No black boxes.

## Cloud Storage (v6.1) — Zero-Cost Cloud in One Line

Soul takes a radically different approach to cloud storage:

```js
DATA_DIR: 'G:/My Drive/n2-soul'  // That's it. Your AI memory is now in Google Drive.
```

Because Soul stores everything as plain JSON files, any folder sync service works as cloud storage. Google Drive (free 15GB), OneDrive, Dropbox, NAS, USB drive — all supported. Zero API keys. Zero monthly fees. Zero vendor lock-in.

For teams, point multiple agents to the same network path = instant shared memory with zero setup.

## The Numbers

- **41 GitHub stars in 2 days** (after Reddit launch)
- **7 forks** — people are actively building on it
- **v6.1.4** — actively maintained, shipping weekly
- **Only 3 dependencies** — minimal, lightweight, reliable
- **Node.js 18+** — runs anywhere
- **Apache-2.0 license** — fully open source

## The Story Behind Soul

Soul was created by a developer who came back to coding after 30 years. The frustration of watching AI agents forget everything between sessions was the catalyst. "I built Soul because it broke my heart watching my agents lose their memory every session."

What started as a personal tool grew into something the community actually wanted. The project went from zero to 41 stars in just two days after being posted on Reddit, with engaged discussions about enterprise use cases like Vault mode for secret management.

## Why Soul Matters

In the AI agent ecosystem, there are tools for making agents smarter (better models), tools for giving agents abilities (MCP servers), but almost nothing for giving agents **memory**. Soul fills that gap.

The vision: AI agents that truly know you, your codebase, your preferences. Agents that can hand off work to each other seamlessly. Agents that are safe by default, not by hope.

**Soul is the memory layer the AI ecosystem has been missing.**

---

🔗 GitHub: github.com/choihyunsus/soul
📦 npm: n2-soul
🌐 Website: nton2.com
💖 Sponsor: github.com/sponsors/choihyunsus
