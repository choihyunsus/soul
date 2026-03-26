// Soul v9.0 — Utils unit tests. Validates core utility functions.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import targets (from compiled dist/)
import { readJson, writeJson, readFile, writeFile, safePath, nowISO, today, validateFirstLineComment } from '../lib/utils';

const TMP_DIR = path.join(os.tmpdir(), `soul-test-utils-${Date.now()}`);

describe('utils', () => {
  before(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('readJson / writeJson', () => {
    it('should round-trip JSON data', () => {
      const data = { name: 'test', count: 42, nested: { ok: true } };
      const filePath = path.join(TMP_DIR, 'test.json');
      writeJson(filePath, data);
      const result = readJson<typeof data>(filePath);
      assert.deepStrictEqual(result, data);
    });

    it('should return null for missing file', () => {
      const result = readJson(path.join(TMP_DIR, 'nonexistent.json'));
      assert.strictEqual(result, null);
    });

    it('should return null for invalid JSON', () => {
      const filePath = path.join(TMP_DIR, 'bad.json');
      fs.writeFileSync(filePath, '{invalid json!!!', 'utf-8');
      const result = readJson(filePath);
      assert.strictEqual(result, null);
    });
  });

  describe('readFile / writeFile', () => {
    it('should round-trip text content', () => {
      const filePath = path.join(TMP_DIR, 'text.txt');
      writeFile(filePath, 'hello world');
      assert.strictEqual(readFile(filePath), 'hello world');
    });

    it('should create nested directories', () => {
      const filePath = path.join(TMP_DIR, 'deep', 'nested', 'file.txt');
      writeFile(filePath, 'deep');
      assert.strictEqual(readFile(filePath), 'deep');
    });
  });

  describe('safePath', () => {
    it('should allow valid relative paths', () => {
      const result = safePath('core/agent.json', TMP_DIR);
      assert.ok(result);
      assert.ok(result.startsWith(TMP_DIR));
    });

    it('should block directory traversal (..)', () => {
      const result = safePath('../../etc/passwd', TMP_DIR);
      assert.strictEqual(result, null);
    });

    it('should block absolute paths on unix', () => {
      const result = safePath('/etc/passwd', TMP_DIR);
      assert.strictEqual(result, null);
    });
  });

  describe('nowISO / today', () => {
    it('should return ISO format string', () => {
      const iso = nowISO();
      assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('today should return YYYY-MM-DD format', () => {
      const d = today();
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('validateFirstLineComment', () => {
    it('should return true for file with first-line comment', () => {
      const filePath = path.join(TMP_DIR, 'commented.ts');
      fs.writeFileSync(filePath, '// This is a comment\nconst x = 1;', 'utf-8');
      assert.strictEqual(validateFirstLineComment(filePath), true);
    });

    it('should return false for file without comment', () => {
      const filePath = path.join(TMP_DIR, 'nocomment.ts');
      fs.writeFileSync(filePath, 'const x = 1;', 'utf-8');
      assert.strictEqual(validateFirstLineComment(filePath), false);
    });

    it('should return false for non-existent file', () => {
      assert.strictEqual(validateFirstLineComment(path.join(TMP_DIR, 'nope.ts')), false);
    });
  });
});
