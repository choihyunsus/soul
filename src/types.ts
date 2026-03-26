// Soul v9.0 — Central type definitions for all modules.

// ── Soul Board ──

export interface SoulBoard {
  project: string;
  updatedAt: string;
  updatedBy: string | null;
  state: BoardState;
  activeWork: Record<string, ActiveWork | null>;
  fileOwnership: Record<string, FileOwnership>;
  decisions: BoardDecision[];
  handoff: Handoff;
  lastLedger: string | null;
}

export interface BoardState {
  summary: string;
  version: string;
  health: 'unknown' | 'healthy' | 'degraded' | 'critical';
}

export interface ActiveWork {
  task: string;
  since: string;
  files: string[];
}

export interface FileOwnership {
  owner: string | null;
  since?: string;
  intent?: string;
}

export interface Handoff {
  from: string | null;
  summary: string;
  todo: string[];
  blockers: string[];
}

export interface BoardDecision {
  date: string;
  by: string;
  what: string;
  why: string;
}

// ── MCP Tool Server (lightweight typing for server.tool() API) ──

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
}

export interface McpToolServer {
  tool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // SDK handler accepts zod-inferred args — exact type varies per tool registration
    handler: (args: never) => Promise<McpToolResult>,
  ): void;
}

// ── Ledger ──

export interface LedgerEntry {
  id: string;
  agent: string;
  startedAt: string;
  completedAt: string;
  title: string;
  filesCreated: FileChange[];
  filesModified: FileChange[];
  filesDeleted: FileChange[];
  decisions: string[];
  summary: string;
}

export interface FileChange {
  path: string;
  desc: string;
}

// ── Entity Memory ──

export interface EntityRecord {
  type: EntityType;
  name: string;
  attributes: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export type EntityType = 'person' | 'hardware' | 'project' | 'concept' | 'place' | 'service';

// ── Core Memory ──

export interface CoreMemoryData {
  agent: string;
  updatedAt: string;
  entries: Record<string, string>;
}

// ── KV-Cache ──

export interface KVSnapshot {
  id: string;
  projectName: string;
  agentName: string;
  timestamp: string;
  keys: string[];
  context: KVContext;
  accessCount: number;
  lastAccessed: string | null;
  importance: number;
  tier: SnapshotTier;
}

export interface KVContext {
  summary: string;
  decisions: string[];
  todo: string[];
  filesCreated: FileChange[];
  filesModified: FileChange[];
}

export type SnapshotTier = 'hot' | 'warm' | 'cold';

// ── File Index ──

export interface FileIndex {
  updatedAt: string;
  tree: Record<string, FileEntry | DirectoryEntry>;
  directories?: Record<string, string>;
}

export interface FileEntry {
  desc: string;
  created: string;
  modified: string;
  status: 'active' | 'archived' | 'deleted';
}

export interface DirectoryEntry {
  desc: string;
  children: Record<string, FileEntry | DirectoryEntry>;
}

// ── Config ──

export interface SoulConfig {
  SOUL_ROOT: string;
  DATA_DIR: string;
  TIMEZONE: string;
  AGENTS_DIR: string | null;
  LANG: string;
  SEARCH: SearchConfig;
  FILE_TREE: FileTreeConfig;
  WORK: WorkConfig;
  KV_CACHE: KVCacheConfig;
}

export interface SearchConfig {
  maxDepth: number;
  minKeywordLength: number;
  previewLength: number;
  recencyBonus: number;
  defaultMaxResults: number;
  semanticEnabled: boolean;
  semanticWeight: number;
}

export interface FileTreeConfig {
  hidePaths: string[];
  compactPaths: string[];
  childLimit: number;
}

export interface WorkConfig {
  sessionTtlHours: number;
  maxDecisions: number;
}

export interface KVCacheConfig {
  enabled: boolean;
  autoSaveOnWorkEnd: boolean;
  autoLoadOnBoot: boolean;
  backend: 'json' | 'sqlite';
  maxSnapshotsPerProject: number;
  maxSnapshotAgeDays: number;
  compressionTarget: number;
  snapshotDir: string | null;
  sqliteDir: string | null;
  tokenBudget: TokenBudgetConfig;
  tier: TierConfig;
  embedding: EmbeddingConfig;
  backup: BackupConfig;
}

export interface TokenBudgetConfig {
  bootContext: number;
  searchResult: number;
  progressiveLoad: boolean;
}

export interface TierConfig {
  hotDays: number;
  warmDays: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  endpoint?: string | null;
}

export interface BackupConfig {
  enabled: boolean;
  dir?: string | null;
  schedule: 'manual' | 'daily' | 'weekly';
  keepCount: number;
  incremental: boolean;
}


// ── Claim Result ──

export interface ClaimResult {
  ok: boolean;
  owner?: string;
  intent?: string;
}

// ── Project Info ──

export interface ProjectInfo {
  name: string;
  updatedAt: string;
  board: SoulBoard;
}
