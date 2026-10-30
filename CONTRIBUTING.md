# Contributing to Soul

Thank you for your interest in contributing to Soul!

## Getting Started

### Prerequisites

- Node.js 22 or 24 LTS (runtime minimum: 20.19)
- Git
- TypeScript 5.9+

### Setup

1. Fork the repository
2. Clone your fork:
 ```bash
 git clone https://github.com/YOUR_USERNAME/soul.git
 cd soul
 ```
3. Install dependencies:
 ```bash
 npm install
 ```
4. Build and verify:
 ```bash
 npm run verify
 ```
 This runs type checking, ESLint, a clean build and the regression tests.

## How to Contribute

### Reporting Bugs

- Open an [issue](https://github.com/choihyunsus/soul/issues) with `[Bug]` in the title
- Include: Node.js version, OS, MCP client (Cursor/VS Code/etc.), and steps to reproduce
- If possible, include the relevant Soul Board or Ledger output

### Suggesting Features

- Open an [issue](https://github.com/choihyunsus/soul/issues) with `[Feature]` in the title
- Describe the use case and expected behavior
- Bonus: include a rough API design

### Submitting Code

1. Create a feature branch:
 ```bash
 git checkout -b feature/amazing-feature
 ```
2. Make your changes in `src/`
3. Run the full verification pipeline:
 ```bash
 npm run verify
 ```
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
 ```bash
 git commit -m 'feat: add amazing feature'
 ```
5. Push and open a Pull Request:
 ```bash
 git push origin feature/amazing-feature
 ```

## Code Guidelines

### Project Structure

```
soul/
├── src/ # TypeScript source (strict mode)
│ ├── index.ts # Entry point (MCP server setup)
│ ├── types.ts # Shared type definitions
│ ├── lib/ # Core libraries
│ │ ├── config.ts # Config loader (default + local deep merge)
│ │ ├── config.default.ts # Default settings (shipped)
│ │ ├── soul-engine.ts # Core engine
│ │ ├── core-memory.ts # Core Memory (per-agent facts)
│ │ ├── entity-memory.ts # Entity Memory (auto-tracked)
│ │ ├── intercom-log.ts # Inter-agent communication logs
│ │ ├── utils.ts # Shared utilities
│ │ └── kv-cache/ # KV-Cache subsystem
│ │ ├── index.ts # KV-Cache manager
│ │ ├── backup.ts # Backup/restore
│ │ ├── embedding.ts # Ollama embeddings
│ │ ├── snapshot.ts # Snapshot operations
│ │ ├── sqlite-store.ts # SQLite backend
│ │ └── tier-manager.ts # Hot/Warm/Cold tiers
│ ├── tools/ # MCP tool registrations
│ │ ├── brain.ts # n2_brain_read/write, n2_entity_*, n2_core_*
│ │ └── kv-cache.ts # n2_kv_save/load/search/backup/restore/gc
│ ├── sequences/ # Agent lifecycle
│ │ ├── boot.ts # n2_boot
│ │ ├── work.ts # n2_work_start, n2_work_claim, n2_work_log
│ │ └── end.ts # n2_work_end
│ └── tests/ # Unit tests (node:test)
├── dist/ # Compiled output (gitignored)
└── data/ # Runtime data (gitignored, auto-created)
```

### Style

- **TypeScript strict mode** — `strict: true`, zero `any`, explicit return types
- **ESLint strictTypeChecked** — floating promises, type safety violations are errors
- **Minimal dependencies** — Think twice before adding a new package
- **CommonJS output** — Source is TypeScript, compiled to CJS via `tsc`
- **Descriptive naming** — Functions and variables should be self-documenting
- **Error handling** — Always return meaningful error messages to the MCP client
- **No `as any`** — Use `unknown` + type guards, generics, or proper interfaces
- **Function size** — Keep functions under 50 lines, files under 500 lines

### Adding a New Tool

1. Create or edit a file in `src/tools/`
2. Register the tool using the MCP SDK pattern:
 ```typescript
 server.tool('n2_your_tool', 'Description', { /* zod schema */ }, async (params) => {
 // implementation
 return { content: [{ type: 'text', text: 'result' }] };
 });
 ```
3. If it's a new file, import and register it in `src/index.ts`
4. Add corresponding tests in `src/tests/`

### Adding a New Sequence

1. Create or edit a file in `src/sequences/`
2. Follow the existing pattern in `boot.ts` / `work.ts` / `end.ts`
3. Register in `src/index.ts`

## Testing

Soul uses Node.js built-in test runner (`node:test`).

```bash
# Run all tests
npm test

# Full verification (typecheck + build + test)
npm run verify

# Type check only
npm run typecheck

# Lint
npm run lint
npm run lint:fix
```

Unit and integration tests cover persistence, restart/retry, scope isolation and reviewed learning. When adding new features, include relevant tests. Before release, also run `npm run verify:package` to install and exercise the actual tarball in isolation.

## Pull Request Guidelines

- **One feature per PR** — keep PRs focused and reviewable
- **Run `npm run verify`** before submitting — zero type errors, all tests pass
- **Update README** if you add/change tools or features
- **No breaking changes** without discussion in an issue first
- **Keep dependencies minimal** — justify any new package

## Architecture Principles

- **Explicit persistence** — Soul persists requested saves and restores; host hooks and agent tool calls still need to be configured and verified
- **Zero config by default** — Everything should work with just `node dist/index.js`
- **Progressive complexity** — Simple for beginners, powerful for advanced users
- **Multi-agent first** — Every feature should consider concurrent agent scenarios
- **Type safety first** — Zero `any`, strict mode, ESLint enforcement

## Community

- [nton2.com](https://nton2.com)
- [npm](https://www.npmjs.com/package/n2-soul)
- [Issues](https://github.com/choihyunsus/soul/issues)
- lagi0730@gmail.com

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
