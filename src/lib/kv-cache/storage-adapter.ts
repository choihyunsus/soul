// Soul KV-Cache v9.0 — StorageAdapter interface. Common contract for all storage backends.
import type { SessionData, SessionInput } from './schema';

/** Garbage collection result */
export interface GCResult {
  deleted: number;
  tiered?: { hot: number; warm: number; cold: number };
}

/** Common interface for all KV-Cache storage backends (JSON, SQLite, Tiered) */
export interface StorageAdapter {
  /** Save a session snapshot and return its unique ID */
  save(session: SessionInput): Promise<string>;

  /** Load the most recent snapshot for a project */
  loadLatest(projectName: string): Promise<SessionData | null>;

  /** Load a specific snapshot by ID */
  loadById(projectName: string, snapshotId: string): Promise<SessionData | null>;

  /** List snapshots for a project, sorted by recency */
  list(projectName: string, limit?: number): Promise<SessionData[]>;

  /** Search snapshots by keyword query */
  search(query: string, projectName: string, limit?: number): Promise<SessionData[]>;

  /** Garbage collect old snapshots based on age and count limits */
  gc(projectName: string, maxAgeDays?: number, maxCount?: number): Promise<GCResult>;

  /** Touch a snapshot — increment access count and update lastAccessed */
  touch(projectName: string, snapshotId: string): Promise<boolean>;

  /** Cleanup resources (close DB connections, clear caches) */
  dispose?(): void;
}
