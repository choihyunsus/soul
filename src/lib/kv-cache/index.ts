// Soul KV-Cache v9.0 - Orchestrator. Coordinates snapshot, compressor, and adapter.
import path from 'path';
import { memorySegment } from './atomic-json';
import fs from 'fs';
import { logError, logWarn, logInfo, writeFile } from '../utils';
import { SnapshotEngine } from './snapshot';
import { compress } from './compressor';
import { fromMcpSession } from './agent-adapter';
import { extractAtLevel, autoLevel } from './token-saver';
import { TierManager } from './tier-manager';
import { EmbeddingEngine } from './embedding';
import { BackupManager } from './backup';
import { PerfMonitor } from './perf-monitor';
import type { PerfSnapshot } from './perf-monitor';
import type { BackupResult, RestoreResult, ManifestEntry, BackupStatusResult } from './backup';
import type { SessionData } from './schema';
import type { KVCacheConfig } from '../../types';
import type { StorageAdapter } from './storage-adapter';
import { canonicalAgent } from '../continuity';
import { recallTerms, redactMemory } from '../recall';
import { recallQuery, matchRecall, recallExcerpt, markedCorrection } from '../recall-match';

interface LoadOptions {
  agent?: string;
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

// BackupResult type imported from ./backup - no local duplicate needed

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
      // NOTE: require() kept - synchronous function cannot use dynamic import()
      const { SqliteStore, initSqlJs } = require('./sqlite-store') as typeof import('./sqlite-store');
      const sqliteDir = config.sqliteDir || path.join(dataDir, 'kv-cache', 'sqlite');
      const sqliteEngine = new SqliteStore(sqliteDir);
      engine = sqliteEngine;
      readyPromise = initSqlJs().then(() =>
        sqliteEngine.init(),
      ).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[kv-cache] SQLite init failed: ${msg}`);
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
  importance?: number;
  id?: string;
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
  private readonly storageConfig: Partial<KVCacheConfig>;
  private readonly config: KVCacheInternalConfig;
  private readonly embedding: EmbeddingEngine | null;
  private _embeddingReady: boolean;
  private _backup: BackupManager | null;
  private _backupTimer: ReturnType<typeof setTimeout> | null;
  private readonly _readyPromise: Promise<void>;

  private _delayTimer: ReturnType<typeof setTimeout> | null;
  private readonly _perf: PerfMonitor;

  constructor(dataDir: string, config: Partial<KVCacheConfig> = {}) {
    const { engine, readyPromise } = createStorageEngine(dataDir, config);
    this.snapshot = engine;
    this._readyPromise = readyPromise;
    this.dataDir = dataDir;
    this.storageConfig = config;
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
    this._perf = new PerfMonitor({
      windowSize: 50,
      slowThresholdMs: config.perfSlowMs ?? 100,
      criticalThresholdMs: config.perfCriticalMs ?? 500,
    });
    const backupConfig = config.backup;
    if (backupConfig?.enabled) {
      this._backup = new BackupManager(dataDir, {
        snapshotDir: config.snapshotDir ?? undefined, sqliteDir: config.sqliteDir ?? undefined, backend: config.backend,
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

  async ready(): Promise<void> { await this._readyPromise; }

  /** Cleanup timers and resources — call before discarding instance */
  dispose(): void {
    this.stopAutoBackup();
    this.snapshot.dispose?.();
  }

  /** Save a session snapshot with automatic compression */
  async save(agent: string, project: string, sessionData: McpSaveInput): Promise<string> {
    canonicalAgent(agent); memorySegment(project);
    await this._readyPromise;  // M4: wait for SQLite init before any operation
    const normalized = fromMcpSession({ ...sessionData, agent, project });

    if (normalized.context.summary) {
      const result = compress(normalized.context.summary, this.config.compressionTarget);
      normalized.keys = [...new Set([...normalized.keys, ...result.keys])];
      // Keep the original durable text; compression is for presentation only.
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
    const start = performance.now();
    const snap = options.agent === undefined ? await this.snapshot.loadLatest(project)
      : (await this.snapshot.list(project, Number.MAX_SAFE_INTEGER)).find(s => s.agentName === canonicalAgent(options.agent ?? '') && s.projectName === project) ?? null;
    this._perf.record(performance.now() - start);
    if (!snap) return null;

    // Forgetting Curve: track access
    if (snap.id) {
      await this.snapshot.touch(snap.projectName || project, snap.id).catch((e: unknown) => logError('kv-cache:touch', e));
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
    const start = performance.now();
    let results: SessionData[];
    if (this._embeddingReady && this.embedding) {
      results = await this._semanticSearch(query, project, limit);
    } else {
      results = await this.snapshot.search(query, project, limit);
    }
    this._perf.record(performance.now() - start);
    return results;
  }

  /** Scoped search with source receipts; never changes access counts or lessons. */
  async searchScoped(query: string, project: string, agent: string, limit = 5): Promise<{
    results: Array<{ id: string; agent: string; savedAt: string; excerpt: string; score: number }>; limited: boolean; scanned: number;
  }> {
    memorySegment(project); agent = memorySegment(canonicalAgent(agent));
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error('Search limit must be an integer from 1 to 10');
    await this._readyPromise;
    const terms = recallQuery(recallTerms(query.slice(0, 12000)));
    if (!terms.groups.length) return { results: [], limited: false, scanned: 0 };
    const snapshots = await this.snapshot.list(project, 801);
    const candidates = snapshots.slice(0, 800).flatMap(snap => {
      if (snap.projectName !== project || canonicalAgent(snap.agentName) !== agent) return [];
      const savedAt = snap.endedAt || snap.startedAt, stamp = Date.parse(savedAt);
      if (!Number.isFinite(stamp) || stamp > Date.now() + 300000) return [];
      const text = redactMemory([snap.context.summary.slice(0, 16000), ...snap.context.decisions.slice(0, 30)].join('\n'));
      const match = matchRecall(text, terms);
      if (!match.eligible) return [];
      return [{ id: snap.id, agent: snap.agentName, savedAt: new Date(stamp).toISOString(), score: match.score,
        correction: markedCorrection(text), excerpt: recallExcerpt(text, terms, 280) }];
    });
    candidates.sort((a, b) => Number(b.correction) - Number(a.correction) ||
      (a.correction && b.correction ? b.savedAt.localeCompare(a.savedAt) : b.score - a.score) || b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
    return { results: candidates.slice(0, limit), limited: snapshots.length > 800, scanned: Math.min(800, snapshots.length) };
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

  /** Garbage collect old snapshots (perf-aware: auto-tightens when queries slow down) */
  async gc(project: string, maxAgeDays?: number): Promise<{ deleted: number; perfTuned: boolean }> {
    const baseAge = maxAgeDays ?? this.config.maxSnapshotAgeDays;
    const baseCount = this.config.maxSnapshotsPerProject;
    const rec = this._perf.recommendGC(baseAge, baseCount);

    await this._readyPromise;
    const result = await this.snapshot.gc(project, rec.maxAgeDays, rec.maxCount);

    if (rec.aggressive) {
      logWarn('kv-cache:gc', `Perf-tuned GC: ${rec.reason}`);
    } else if (rec.maxAgeDays !== baseAge) {
      logInfo('kv-cache:gc', `Perf-adjusted GC: ${rec.reason}`);
    }

    return { deleted: result.deleted, perfTuned: rec.maxAgeDays !== baseAge || rec.maxCount !== baseCount };
  }

  /** Get current query performance metrics */
  getPerfSnapshot(): PerfSnapshot {
    return this._perf.getSnapshot();
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
    const dir = path.join(this.dataDir, 'kv-cache', 'embeddings', memorySegment(project));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, `${snapshotId}.json`), JSON.stringify(vector));
  }

  private _loadEmbedding(project: string, snapshotId: string): number[] | null {
    const filePath = path.join(this.dataDir, 'kv-cache', 'embeddings', memorySegment(project), `${memorySegment(snapshotId)}.json`);
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
    if (!this._backup) this._backup = new BackupManager(this.dataDir, { snapshotDir: this.storageConfig.snapshotDir ?? undefined, sqliteDir: this.storageConfig.sqliteDir ?? undefined, backend: this.storageConfig.backend, dir: this.storageConfig.backup?.dir ?? undefined });
    return this._backup.backup(project, options);
  }

  /** Restore from backup */
  async restore(
    project: string, backupId?: string | null, options: { target?: 'sqlite' | 'json' } = {},
  ): Promise<RestoreResult> {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, { snapshotDir: this.storageConfig.snapshotDir ?? undefined, sqliteDir: this.storageConfig.sqliteDir ?? undefined, backend: this.storageConfig.backend, dir: this.storageConfig.backup?.dir ?? undefined });
    return this._backup.restore(project, backupId, options);
  }

  /** List backup history for a project */
  listBackups(project: string): (ManifestEntry & { sizeFormatted: string })[] {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, { snapshotDir: this.storageConfig.snapshotDir ?? undefined, sqliteDir: this.storageConfig.sqliteDir ?? undefined, backend: this.storageConfig.backend, dir: this.storageConfig.backup?.dir ?? undefined });
    return this._backup.list(project);
  }

  /** Backup status for a project */
  backupStatus(project: string): BackupStatusResult {
    if (!this._backup) this._backup = new BackupManager(this.dataDir, { snapshotDir: this.storageConfig.snapshotDir ?? undefined, sqliteDir: this.storageConfig.sqliteDir ?? undefined, backend: this.storageConfig.backend, dir: this.storageConfig.backup?.dir ?? undefined });
    return this._backup.status(project);
  }

  private async _runAutoBackup(): Promise<void> {
    if (!this._backup) return;
    const sqlite = this.config.backend === 'sqlite';
    const snapBaseDir = sqlite ? this.storageConfig.sqliteDir || path.join(this.dataDir, 'kv-cache', 'sqlite')
      : this.storageConfig.snapshotDir || path.join(this.dataDir, 'kv-cache', 'snapshots');
    try {
      if (!fs.existsSync(snapBaseDir)) return;
      const projects = fs.readdirSync(snapBaseDir, { withFileTypes: true })
        .filter(d => sqlite ? d.isFile() && d.name.endsWith('.sqlite') : d.isDirectory())
        .map(d => sqlite ? d.name.slice(0, -7) : d.name);

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
