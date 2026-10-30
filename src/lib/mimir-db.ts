// Shared SQLite boundary for scoped learning. Additive schema changes only.
import { SCHEMA_SQL } from './mimir-schema';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { canonicalAgent } from './continuity';
import { memorySegment } from './kv-cache/atomic-json';

export function learningIdentity(project: string, agent: string): string {
  memorySegment(project);
  return memorySegment(canonicalAgent(agent));
}
// Column names are internal constants, never tool input.
export const ownerSql = (column: string): string => column;
export function openMimir(dataDir: string, write = false): Database.Database {
  const file = path.join(dataDir, 'mimir.db'), exists = fs.existsSync(file);
  if (write) fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(file, { readonly: !write, fileMustExist: !write, timeout: 1500 });
  try {
    db.pragma('foreign_keys=ON');
    if (write && !exists) db.exec(SCHEMA_SQL);
    return db;
  } catch (error) { db.close(); throw error; }
}
