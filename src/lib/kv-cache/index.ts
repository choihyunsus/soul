// Soul KV-Cache v9.0 — Orchestrator. Coordinates snapshot, compressor, and adapter.
import path from 'path';
import fs from 'fs';
import { logError, logWarn, logInfo, writeFile } from '../utils';
import { SnapshotEngine } from './snapshot';
import { compress } from './compressor';
import { fromMcpSession } from './agent-adapter';
import { extractAtLevel, autoLevel } from './token-saver';
import { TierManager } from './tier-manager';
import { EmbeddingEngine } from './embedding';
import { BackupManager } from './backup';
import type { BackupResult, RestoreResult, ManifestEntry, BackupStatusResult } from './backup';
import type { SessionData } from './schema';
import type { KVCacheConfig } from '../../types';
import type { StorageAdapter } from './storage-adapter';

interface LoadOptions {
  level?: string;
  budget?: number;
}

interface LoadedSnapshot extends SessionData {
  _resumePrompt: string;
  _level: string;
  _promptTokens: number;
}

interface SemanticCandidate {
  id: string;
  vector: number[];
  snap: SessionData;
}

interface KVCacheInternalConfig {
  backend: string;
  compressionTarget: number;
  maxSnapshotsPerProject: number;
  maxSnapshotAgeDays: number;
  tokenBudget: {
    bootContext: number;
    searchResult: number;
    progressiveLoad: boolean;
  };
}

// BackupResult type imported from ./backup — no local duplicate needed

const DEFAULT_COMPRESSION_TARGET = 1000;
const AUTO_BACKUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SNAPSHOTS = 50;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_BOOT_TOKEN_BUDGET = 2000;
const DEFAULT_SEARCH_TOKEN_BUDGET = 500;

/** Creates the appropriate storage engine based on config */
function createStorageEngine(
  dataDir: string, config: Partial<KVCacheConfig>,
): { engine: StorageAdapter; readyPromise: Promise<void> } {
  const backend = config.backend || 'json';
  const snapshotDir = config.snapshotDir || path.join(dataDir, 'kv-cache', 'snapshots');
  let engine: StorageAdapter;
  let readyPromise: Promise<void> = Promise.resolve();

  if (backend === 'sqlite') {
    try {
      // NOTE: require() kept — synchronous function cannot use dynamic import()
      const { SqliteStore, initSqlJs } = require('./sqlite-store') as typeof import('./sqlite-store');
      const sqliteDir = config.sqliteDir || path.join(dataDir, 'kv-cache', 'sqlite');
      const sqliteEngine = new SqliteStore(sqliteDir);
      engine = sqliteEngine;
      readyPromise = initSqlJs().then(() =>
        sqliteEngine.init(),
      ).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[kv-cache] SQLite init failed: ${msg}`);
      });
    } catch (e) {
      logError('kv-cache:sqlite', `SQLite unavailable (${e instanceof Error ? e.message : String(e)}), falling back to JSON`);
      engine = new SnapshotEngine(snapshotDir);
    }
  } else {
    engine = new SnapshotEngine(snapshotDir);
  }

  const tierConfig = config.tier;
  if (tierConfig) {
    return { engine: new TierManager(engine, tierConfig), readyPromise };
  }

  return { engine, readyPromise };
}

interface McpSaveInput {
  agent?: string;
  project?: string;
  summary?: string;
  decisions?: string[];
  filesCreated?: Array<{ path: string; desc?: string } | string>;
  filesModified?: Array<{ path: string; desc?: string } | string>;
  filesDeleted?: Array<{ path: string; desc?: string } | string>;
  todo?: string[];
  startedAt?: string;
  parentSessionId?: string | null;
}

/** Main KV-Cache orchestrator */
export class SoulKVCache {
  readonly snapshot: StorageAdapter;
  private readonly dataDir: string;
  private readonly config: KVCacheInternalConfig;
  private readonly embedding: EmbeddingEngine | null;
  private _embeddingReady: boolean;
  private _backup: BackupManager | null;
  private _backupTimer: ReturnType<typeof setTimeout> | null;
  private readonly _readyPromise: Promise<void>;

  private _delayTimer: ReturnType<typeof setTimeout> | null;

  constructor(dataDir: string, config: Partial<KVCacheConfig> = {}) {
    const { engine, readyPromise } = createStorageEngine(dataDir, config);
    this.snapshot = engine;
    this._readyPromise = readyPromise;
    this.dataDir = dataDir;
    this.config = {
      backend: config.backend || 'json',
      compressionTarget: config.compressionTarget || DEFAULT_COMPRESSION_TARGET,
      maxSnapshotsPerProject: config.maxSnapshotsPerProject || DEFAULT_MAX_SNAPSHOTS,
      maxSnapshotAgeDays: config.maxSnapshotAgeDays || DEFAULT_MAX_AGE_DAYS,
      tokenBudget: config.tokenBudget || {
        bootContext: DEFAULT_BOOT_TOKEN_BUDGET, searchResult: DEFAULT_SEARCH_TOKEN_BUDGET, progressiveLoad: true,
      },
    };

    // Embedding engine (optional, requires Ollama)
    this.embedding = null;
    this._embeddingReady = false;
    const embConfig = config.embedding;
    if (embConfig?.enabled) {
      this.embedding = new EmbeddingEngine({ model: embConfig.model, endpoint: embConfig.endpoint ?? undefined });
      this.embedding.isAvailable().then(ok => {
        this._embeddingReady = ok;
        if (ok && this.embedding) {
          logInfo('kv-cache:embedding', `Embedding ready: ${embConfig.model}`);
        } else {
          logInfo('kv-cache:embedding', 'Embedding unavailable, falling back to keyword search');
        }
      }).catch(() => { this._embeddingReady = false; });
    }

    // Backup manager (optional)
    this._backup = null;
    this._backupTimer = null;
    this._delayTimer = null;
    const backupConfig = config.backup;
    if (backupConfig?.enabled) {
      this._backup = new BackupManager(dataDir, {
        dir: backupConfig.dir ?? undefined,
        keepCount: backupConfig.keepCount,
        incremental: backupConfig.incremental,
      });
      const schedule = backupConfig.schedule || 'daily';
      if (schedule !== 'manual') {
        const intervalMs = schedule === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        // C5 fix: separate delay timer from recurring timer for clean disposal
        this._delayTimer = setTimeout(() => {
          this._delayTimer = null;
          void this._runAutoBackup().catch((e: unknown) => logError('kv-cache:auto-backup', e));
          this._backupTimer = setInterval(() => {
            void this._runAutoBackup().catch((e: unknown) => logError('kv-cache:auto-backup', e));
          }, intervalMs);
          if (this._backupTimer && 'unref' in this._backupTimer) {
            (this._backupTimer).unref();
          }
        }, AUTO_BACKUP_DELAY_MS);
        if (this._delayTimer && 'unref' in this._delayTimer) {
          (this._delayTimer).unref();
        }
        logInfo('kv-cache:backup', `Auto-backup scheduled: ${schedule}`);
      }
    }
  }

  /** Cleanup timers and resources — call before discarding instance */
  dispose(): void {
    this.stopAutoBackup();
  }

  /** Save a session snapshot with automatic compression */
  async save(agent: string, project: string, sessionData: McpSaveInput): Promise<string> {
    await this._readyPromise;  // M4: wait for SQLite init before any operation
    const normalized = fromMcpSession({ agent, project, ...sessionData });

    if (normalized.context.summary) {
      const result = compress(normalized.context.summary, this.config.compressionTarget);
      normalized.keys = [...new Set([...normalized.keys, ...result.keys])];
      normalized.context.summary = result.compressed || normalized.context.summary;
    }

    const id = await this.snapshot.save(normalized);

    // Generate embedding in background (non-blocking)
    if (this._embeddingReady && this.embedding) {
      const text = this.embedding.snapshotToText(normalized);
      this.embedding.embed(text).then(vec => {
        if (vec.length > 0) {
          this._storeEmbedding(project, id, vec);
        } else {
          logWarn('kv-cache:embed', `Empty embedding for snapshot ${id} — semantic search will skip it`);
        }
      }).catch((e: unknown) => { logError('kv-cache:embed', `Embedding failed for snapshot ${id}: ${e instanceof Error ? e.message : String(e)}`); });
    }

    return id;
  }

  /** Load the most recent snapshot for a project */
  async load(project: string, options: LoadOptions = {}): Promise<LoadedSnapshot | null> {
    await this._readyPromise;
    const snap = await this.snapshot.loadLatest(project);
    if (!snap) return null;

    // Forgetting Curve: track access
    if (snap.id) {
      this.snapshot.touch(snap.projectName || project, snap.id).catch((e: unknown) => logError('kv-cache:touch', e));
    }

    const level = options.level || 'auto';
    const budget = options.budget || this.config.tokenBudget.bootContext;

    const loaded = snap as LoadedSnapshot;
    if (level === 'auto') {
      const result = autoLevel(snap, budget);
      loaded._resumePrompt = result.prompt;
      loaded._level = result.level;
      loaded._promptTokens = result.tokens;
    } else {
      const result = extractAtLevel(snap, level);
      loaded._resumePrompt = result.prompt;
      loaded._level = result.level;
      loaded._promptTokens = result.tokens;
    }

    return loaded;
  }

  /** Search across snapshots by keyword or semantic similarity */
  async search(query: string, project: string, limit: number = 10): Promise<SessionData[]> {
    await this._readyPromise;
    if (this._embeddingReady && this.embedding) {
      return this._semanticSearch(query, project, limit);
    }
    return await this.snapshot.search(query, project, limit);
  }

  private async _semanticSearch(query: string, project: string, limit: number): Promise<SessionData[]> {
    try {
      if (!this.embedding) return await this.snapshot.search(query, project, limit);
      const queryVec = await this.embedding.embed(query);
      if (queryVec.length === 0) return await this.snapshot.search(query, project, limit);

      const allSnaps = await this.snapshot.list(project, 100);
      const candidates: SemanticCandidate[] = [];

      for (const snap of allSnaps) {
        const stored = this._loadEmbedding(project, snap.id);
        if (stored) candidates.push({ id: snap.id, vector: stored, snap });
      }

      if (candidates.length === 0) return await this.snapshot.search(query, project, limit);

      const ranked = this.embedding.rankBySimilarity(queryVec, candidates, limit, 0.2);
      return ranked.map(r => {
        const match = candidates.find(c => c.id === r.id);
        if (!match) return null;
        return { ...match.snap, _score: r.score } as SessionData & { _score: number };
      }).filter(Boolean) as (SessionData & { _score: number })[];
    } catch (e) {
      logError('kv-cache:semantic-search', e);
      return await this.snapshot.search(query, project, limit);
    }
  }

  /** List snapshots for a project */
  async listSnapshots(project: string, limit: number = 10): Promise<SessionData[]> {
    return await this.snapshot.list(project, limit);
  }

  /** Garbage collect old snapshots */
  async gc(project: string, maxAgeDays?: number): Promise<{ deleted: number }> {
    const age = maxAgeDays ?? this.config.maxSnapshotAgeDays;
    await this._readyPromise;
    return await this.snapshot.gc(project, age, this.config.maxSnapshotsPerProject);
  }

  /** Estimate token count for a text string */
  estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
    const asciiCount = text.length - cjkCount;
    return Math.ceil(asciiCount / 4 + cjkCount / 2);
  }

  /** Returns current backend info for diagnostics */
  async backendInfo(project: string): Promise<Record<string, unknown>> {
    const count = (await this.listSnapshots(project, 9999)).length;
    return {
      backend: this.config.backend,
      snapshotCount: count,
      embedding: this._embeddingReady && this.embedding ? `active (${this.embedding['model']})` : 'off',
    };
  }

  private _storeEmbedding(project: string, snapshotId: string, vector: number[]): void {
    const dir = path.join(this.dataDir, 'kv-cache', 'embeddings', project);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, `${snapshotId}.json`), JSON.stringify(vector));
  }

  private _loadEmbedding(project: string, snapshotId: string): number[] | null {
    const filePath = path.join(this.dataDir, 'kv-cache', 'embeddings', project, `${snapshotId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as number[];
    } catch (e) {
      logError('kv-cache:load-embedding', e);
      return null;
    }
  }

  /** Backup project data */
  async backup(project: string, options: { full?: boolean } = {}): Promise<BackupResult> {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, {});
    return this._backup.backup(project, options);
  }

  /** Restore from backup */
  async restore(
    project: string, backupId?: string | null, options: { target?: 'sqlite' | 'json' } = {},
  ): Promise<RestoreResult> {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, {});
    return this._backup.restore(project, backupId, options);
  }

  /** List backup history for a project */
  listBackups(project: string): (ManifestEntry & { sizeFormatted: string })[] {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, {});
    return this._backup.list(project);
  }

  /** Backup status for a project */
  backupStatus(project: string): BackupStatusResult {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, {});
    return this._backup.status(project);
  }

  private async _runAutoBackup(): Promise<void> {
    if (!this._backup) return;
    const snapBaseDir = path.join(this.dataDir, 'kv-cache', 'snapshots');
    try {
      if (!fs.existsSync(snapBaseDir)) return;
      const projects = fs.readdirSync(snapBaseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_'))
        .map(d => d.name);

      for (const project of projects) {
        try {
          const result = await this._backup.backup(project, {});
          if (result.type !== 'skip' && result.type !== 'empty') {
            console.error(`[kv-cache] Auto-backup: ${project} → ${result.sizeFormatted || ''} (${result.type})`);
          }
        } catch (e) { logError('kv-cache:auto-backup', `${project}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    } catch (err) {
      console.error(`[kv-cache] Auto-backup error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Stop auto-backup scheduler and cleanup */
  stopAutoBackup(): void {
    if (this._delayTimer) {
      clearTimeout(this._delayTimer);
      this._delayTimer = null;
    }
    if (this._backupTimer) {
      clearInterval(this._backupTimer);
      this._backupTimer = null;
    }
  }
}
