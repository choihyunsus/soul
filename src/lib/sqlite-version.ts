// Check the actual engine before using a writable shared memory database.
import type Database from 'better-sqlite3';

export function isSupportedSqliteVersion(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) return false;
  const [major = 0, minor = 0, patch = 0] = value.split('.').map(Number);
  return major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)));
}

export function assertSqliteRuntime(db: Pick<Database.Database, 'prepare'>): string {
  const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined;
  if (!isSupportedSqliteVersion(row?.version)) {
    throw new Error('SQLite 3.51.3 or later is required for WAL-reset fixes. Install better-sqlite3 12.8 or later.');
  }
  return row.version;
}
