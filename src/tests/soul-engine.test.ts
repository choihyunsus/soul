// Soul v9.0 — SoulEngine unit tests. Validates board CRUD, ledger write, file ownership.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { SoulEngine } from '../lib/soul-engine';

const TMP_DIR = path.join(os.tmpdir(), `soul-test-engine-${Date.now()}`);
const PROJECT = 'test-project';

describe('SoulEngine', () => {
  let engine: SoulEngine;

  before(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    engine = new SoulEngine(TMP_DIR);
  });

  after(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('Board CRUD', () => {
    it('should create default board on first read', () => {
      const board = engine.readBoard(PROJECT);
      assert.strictEqual(board.project, PROJECT);
      assert.strictEqual(board.state.health, 'unknown');
      assert.ok(Array.isArray(board.decisions));
    });

    it('should persist board changes on write', () => {
      const board = engine.readBoard(PROJECT);
      board.state.health = 'healthy';
      board.state.summary = 'Test summary';
      engine.writeBoard(PROJECT, board);

      const reloaded = engine.readBoard(PROJECT);
      assert.strictEqual(reloaded.state.health, 'healthy');
      assert.strictEqual(reloaded.state.summary, 'Test summary');
    });
  });

  describe('Ledger', () => {
    it('should write immutable ledger entry', () => {
      const result = engine.writeLedger(PROJECT, 'rose', {
        startedAt: new Date().toISOString(),
        title: 'Test work',
        summary: 'Did some testing',
        filesCreated: [{ path: 'test.ts', desc: 'test file' }],
        filesModified: [],
        filesDeleted: [],
        decisions: ['decided to test'],
      });

      assert.ok(result.id);
      assert.ok(result.path);
      assert.ok(fs.existsSync(result.path));

      const content = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
      assert.strictEqual(content.agent, 'rose');
      assert.strictEqual(content.title, 'Test work');
    });
  });

  describe('File Ownership', () => {
    it('should claim file successfully', () => {
      const result = engine.claimFile(PROJECT, 'src/index.ts', 'rose', 'editing');
      assert.strictEqual(result.ok, true);
    });

    it('should block duplicate claims from other agents', () => {
      engine.claimFile(PROJECT, 'src/blocked.ts', 'rose', 'editing');
      const result = engine.claimFile(PROJECT, 'src/blocked.ts', 'lisa', 'also editing');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.owner, 'rose');
    });

    it('should release files by agent', () => {
      engine.claimFile(PROJECT, 'src/release-me.ts', 'rose', 'temp');
      engine.releaseFiles(PROJECT, 'rose');

      const result = engine.claimFile(PROJECT, 'src/release-me.ts', 'lisa', 'free now');
      assert.strictEqual(result.ok, true);
    });
  });

  describe('Project listing', () => {
    it('should list created projects', () => {
      const projects = engine.listAllProjects();
      const names = projects.map(p => p.name);
      assert.ok(names.includes(PROJECT));
    });
  });
});
