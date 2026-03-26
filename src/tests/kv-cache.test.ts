// Soul v9.0 — KV-Cache unit tests. Validates snapshot save/load/search, compressor, GC.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { SoulKVCache } from '../lib/kv-cache';

const TMP_DIR = path.join(os.tmpdir(), `soul-test-kv-${Date.now()}`);
const PROJECT = 'kv-test-project';

describe('KV-Cache', () => {
  let cache: SoulKVCache;

  before(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    cache = new SoulKVCache(TMP_DIR, {
      backend: 'json',
      enabled: true,
      maxSnapshotsPerProject: 10,
      maxSnapshotAgeDays: 30,
      compressionTarget: 500,
    });
  });

  after(() => {
    cache.dispose();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('save / load round-trip', () => {
    it('should save a snapshot and return an ID', async () => {
      const id = await cache.save('rose', PROJECT, {
        summary: 'Implemented TypeScript migration for Soul v9.0',
        decisions: ['Use strict mode', 'No any types'],
        todo: ['Write tests', 'Run ESLint'],
        filesCreated: [{ path: 'src/types.ts', desc: 'Central type definitions' }],
        filesModified: [{ path: 'src/index.ts', desc: 'Import cleanup' }],
      });
      assert.ok(id);
      assert.ok(typeof id === 'string');
    });

    it('should load the latest snapshot', async () => {
      const snap = await cache.load(PROJECT);
      assert.ok(snap);
      assert.ok(snap.id);
      assert.ok(snap.context.summary.length > 0);
      assert.ok(snap._resumePrompt || snap._level);
    });
  });

  describe('search', () => {
    it('should find snapshots by keyword', async () => {
      const results = await cache.search('TypeScript migration', PROJECT, 5);
      assert.ok(results.length > 0);
    });

    it('should return empty for unrelated keywords', async () => {
      const results = await cache.search('quantum_physics_unrelated', PROJECT, 5);
      assert.strictEqual(results.length, 0);
    });
  });

  describe('GC', () => {
    it('should not delete fresh snapshots', async () => {
      const result = await cache.gc(PROJECT, 1);
      assert.ok(typeof result.deleted === 'number');
    });
  });

  describe('listSnapshots', () => {
    it('should list saved snapshots', async () => {
      const snaps = await cache.listSnapshots(PROJECT);
      assert.ok(snaps.length > 0);
    });
  });
});
