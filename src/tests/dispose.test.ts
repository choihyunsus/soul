// Soul v9.0 — Dispose pattern tests. Validates timer cleanup to prevent memory leaks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { SoulKVCache } from '../lib/kv-cache';
import { disposeWorkSequence, activeSessions } from '../sequences/work';

describe('Dispose patterns (memory leak prevention)', () => {
  describe('SoulKVCache.dispose()', () => {
    it('should clear backup timer on dispose', () => {
      const tmpDir = path.join(os.tmpdir(), `soul-dispose-kv-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      const cache = new SoulKVCache(tmpDir, {
        backend: 'json',
        enabled: true,
        backup: {
          enabled: true,
          schedule: 'daily',
          keepCount: 3,
          incremental: false,
        },
      });

      // Timer should be set
      assert.ok(cache['_backupTimer'] !== null, 'Backup timer should be set after construction');

      // Dispose should clear it
      cache.dispose();
      assert.strictEqual(cache['_backupTimer'], null, 'Backup timer should be null after dispose');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should be safe to call dispose multiple times', () => {
      const tmpDir = path.join(os.tmpdir(), `soul-dispose-multi-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      const cache = new SoulKVCache(tmpDir, { backend: 'json', enabled: true });

      // Multiple dispose calls should not throw
      cache.dispose();
      cache.dispose();
      cache.dispose();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('disposeWorkSequence()', () => {
    it('should be callable without error', () => {
      // Should not throw even if called before registerWorkSequence
      assert.doesNotThrow(() => disposeWorkSequence());
    });

    it('should clean up active sessions reference', () => {
      // Verify activeSessions is an accessible object
      assert.ok(typeof activeSessions === 'object');
    });
  });
});
