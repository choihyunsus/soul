// Soul KV-Cache v9.0 — Tiered storage manager. Hot/Warm/Cold lifecycle.
import type { SessionData, SessionInput } from './schema';
import type { SnapshotTier } from '../../types';
import type { SnapshotEngine } from './snapshot';

interface TierSpec {
  name: string;
  maxAgeDays: number;
}

interface TierConfig {
  hotDays?: number;
  warmDays?: number;
}

interface TieredSnapshot extends SessionData {
  _tier: SnapshotTier;
}

interface GCExtendedResult {
  deleted: number;
  tiered: { hot: number; warm: number; cold: number };
  hotCount: number;
  warmCount: number;
  coldCount: number;
}

interface TierSummary {
  hot: number;
  warm: number;
  cold: number;
  total: number;
}

/** Tiered storage levels for KV-Cache snapshots */
export const TIERS: Record<string, TierSpec> = {
  HOT: { name: 'hot', maxAgeDays: 7 },
  WARM: { name: 'warm', maxAgeDays: 30 },
  COLD: { name: 'cold', maxAgeDays: Infinity },
};

const MAX_HOT_PER_PROJECT = 20;

/**
 * TierManager wraps a storage engine and adds tiered caching.
 * Hot tier snapshots are kept in memory for fast access.
 */
export class TierManager {
  private readonly engine: SnapshotEngine;
  private readonly hotDays: number;
  private readonly warmDays: number;
  private _hotCache: Record<string, Record<string, SessionData>>;

  constructor(storageEngine: SnapshotEngine, config: TierConfig = {}) {
    this.engine = storageEngine;
    this.hotDays = config.hotDays || TIERS['HOT']!.maxAgeDays;
    this.warmDays = config.warmDays || TIERS['WARM']!.maxAgeDays;
    this._hotCache = {};
  }

  /** Classify a snapshot's tier based on age */
  classify(snapshot: SessionData): SnapshotTier {
    const timestamp = snapshot.endedAt || snapshot.startedAt;
    if (!timestamp) return 'warm';

    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    if (ageDays <= this.hotDays) return 'hot';
    if (ageDays <= this.warmDays) return 'warm';
    return 'cold';
  }

  /** Save with automatic hot-cache population */
  async save(session: SessionInput): Promise<string> {
    const id = await this.engine.save(session);
    const project = session.projectName || 'default';
    if (!this._hotCache[project]) this._hotCache[project] = {};
    this._hotCache[project][id] = { ...session, id } as SessionData;

    // LRU cap: evict oldest entries when exceeding limit
    const cache = this._hotCache[project];
    const keys = Object.keys(cache);
    if (keys.length > MAX_HOT_PER_PROJECT) {
      const sorted = keys.sort((a, b) => {
        const ta = new Date(cache[a]?.endedAt || cache[a]?.startedAt || 0).getTime();
        const tb = new Date(cache[b]?.endedAt || cache[b]?.startedAt || 0).getTime();
        return ta - tb;
      });
      const toRemove = sorted.slice(0, keys.length - MAX_HOT_PER_PROJECT);
      for (const k of toRemove) delete cache[k];
    }

    return id;
  }

  /** Load latest with hot-cache check first */
  async loadLatest(projectName: string): Promise<SessionData | null> {
    const cache = this._hotCache[projectName];
    if (cache) {
      const entries = Object.values(cache);
      if (entries.length > 0) {
        entries.sort((a, b) => {
          const ta = new Date(b.endedAt || b.startedAt).getTime();
          const tb = new Date(a.endedAt || a.startedAt).getTime();
          return ta - tb;
        });
        return entries[0] ?? null;
      }
    }
    return await this.engine.loadLatest(projectName);
  }

  /** List snapshots with tier annotations */
  async list(projectName: string, limit: number = 10): Promise<TieredSnapshot[]> {
    const snapshots = await this.engine.list(projectName, limit);
    return snapshots.map(snap => ({ ...snap, _tier: this.classify(snap) }));
  }

  /** Search with tier annotations */
  async search(query: string, projectName: string, limit: number = 10): Promise<TieredSnapshot[]> {
    const results = await this.engine.search(query, projectName, limit);
    return results.map(snap => ({ ...snap, _tier: this.classify(snap) }));
  }

  /** Tier-aware garbage collection */
  async gc(
    projectName: string, maxAgeDays: number = 30, maxCount: number = 50,
  ): Promise<GCExtendedResult> {
    const result = await this.engine.gc(projectName, maxAgeDays, maxCount);
    await this._refreshHotCache(projectName);

    const remaining = await this.list(projectName, 500);
    const counts = { hot: 0, warm: 0, cold: 0 };
    for (const snap of remaining) {
      counts[snap._tier || 'warm']++;
    }

    return {
      deleted: result.deleted,
      tiered: result.tiered || counts,
      hotCount: counts.hot,
      warmCount: counts.warm,
      coldCount: counts.cold,
    };
  }

  /** Refresh hot cache for a project from storage */
  private async _refreshHotCache(projectName: string): Promise<void> {
    const snaps = await this.engine.list(projectName, 100);
    const cache: Record<string, SessionData> = {};
    for (const snap of snaps) {
      if (this.classify(snap) === 'hot') cache[snap.id] = snap;
    }
    this._hotCache[projectName] = cache;
  }

  /** Get tier distribution summary for a project */
  async tierSummary(projectName: string): Promise<TierSummary> {
    const snaps = await this.list(projectName, 500);
    const counts: TierSummary = { hot: 0, warm: 0, cold: 0, total: snaps.length };
    for (const snap of snaps) {
      counts[snap._tier || 'warm']++;
    }
    return counts;
  }

  /** Warm up: preload hot tier snapshots into memory */
  async warmUp(projectName: string): Promise<number> {
    await this._refreshHotCache(projectName);
    return Object.keys(this._hotCache[projectName] || {}).length;
  }

  /** Clear hot cache for a project */
  evict(projectName: string): void {
    delete this._hotCache[projectName];
  }

  /** Proxy: loadById */
  async loadById(projectName: string, snapshotId: string): Promise<SessionData | null> {
    return await this.engine.loadById(projectName, snapshotId);
  }

  /** Proxy: touch (Forgetting Curve access tracking) */
  async touch(projectName: string, snapshotId: string): Promise<boolean> {
    return await this.engine.touch(projectName, snapshotId);
  }

  /** Dispose all caches */
  dispose(): void {
    this._hotCache = {};
  }
}
