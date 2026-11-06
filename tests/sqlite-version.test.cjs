// Verify the running SQLite engine and rejection of older shared-database drivers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { isSupportedSqliteVersion, assertSqliteRuntime } = require('../dist/lib/sqlite-version');

test('Mimir requires a SQLite engine containing the WAL-reset fix', () => {
  for (const version of ['3.49.2', '3.51.2', 'invalid', null]) {
    assert.equal(isSupportedSqliteVersion(version), false);
    assert.throws(() => assertSqliteRuntime({ prepare: () => ({ get: () => ({ version }) }) }), /3.51.3/);
  }
  for (const version of ['3.51.3', '3.54.0', '3.100.0', '4.0.0']) assert.equal(isSupportedSqliteVersion(version), true);
  const db = new Database(':memory:');
  try { assert.equal(isSupportedSqliteVersion(assertSqliteRuntime(db)), true); }
  finally { db.close(); }
});
