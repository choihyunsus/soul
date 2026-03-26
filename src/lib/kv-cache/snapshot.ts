// Soul KV-Cache v9.0 — Snapshot engine. Creates/restores session snapshots from disk.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createSession, migrateSession } from './schema';
import type { SessionData, SessionInput } from './schema';
import type { SnapshotTier } from '../../types';
import { logError } from '../utils';

interface GCResult {
  deleted: number;
  tiered: { hot: number; warm: number; cold: number };
}

interface ScoredSnapshot extends SessionData {
  _score: number;
}

interface SnapshotPatch {
  tier?: SnapshotTier;
  accessCount?: number;
  lastAccessed?: string;
}

const DECAY_RATE = 0.05;

/**
 * Forgetting Curve retention score.
 * R = importance × (1 + log2(1 + accessCount)) × e^(-λ × ageInDays)
 */
export function calculateRetention(snap: SessionData): number {
  const importance = snap.importance ?? 0.5;
  const accessCount = snap.accessCount || 0;
  const lastAccessed = snap.lastAccessed || snap.endedAt || snap.startedAt;
  const ageMs = Date.now() - new Date(lastAccessed).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));

  const decayFactor = Math.exp(-DECAY_RATE * ageDays);
  const accessBoost = 1 + Math.log2(1 + accessCount);

  const raw = importance * accessBoost * decayFactor;
  return Math.min(1.0, Math.max(0.0, raw));
}

/** Snapshot engine for session persistence */
export class SnapshotEngine {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Save a session snapshot to disk */
  async save(session: SessionInput): Promise<string> {
    const s = createSession(session);
    s.endedAt = s.endedAt || new Date().toISOString();

    const dateStr = (s.endedAt ?? '').split('T')[0] ?? '';
    const dir = path.join(this.baseDir, s.projectName, dateStr);
    await fsp.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${s.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(s, null, 2), 'utf-8');
    return s.id;
  }

  /** Load the most recent snapshot for a project */
  async loadLatest(projectName: string): Promise<SessionData | null> {
    const snapshots = await this.list(projectName, 1);
    return snapshots.length > 0 ? snapshots[0] ?? null : null;
  }

  /** Load a specific snapshot by ID */
  async loadById(projectName: string, snapshotId: string): Promise<SessionData | null> {
    const projectDir = path.join(this.baseDir, projectName);
    if (!fs.existsSync(projectDir)) return null;

    const dateDirs = this._getDateDirs(projectDir);
    for (const dateDir of dateDirs) {
      const filePath = path.join(dateDir, `${snapshotId}.json`);
      if (fs.existsSync(filePath)) {
        return await this._readSnapshot(filePath);
      }
    }
    return null;
  }

  /** List snapshots for a project, sorted by recency */
  async list(projectName: string, limit: number = 10): Promise<SessionData[]> {
    const projectDir = path.join(this.baseDir, projectName);
    if (!fs.existsSync(projectDir)) return [];

    const dateDirs = this._getDateDirs(projectDir);
    const all: SessionData[] = [];

    for (const dateDir of dateDirs) {
      try {
        const files = (await fsp.readdir(dateDir)).filter(f => f.endsWith('.json'));
        const readPromises = files.map(file => this._readSnapshot(path.join(dateDir, file)));
        const snapshots = await Promise.all(readPromises);
        for (const snap of snapshots) {
          if (snap) all.push(snap);
        }
      } catch (e) { logError('snapshot:list', e); }
    }

    all.sort((a, b) => {
      const ta = new Date(b.endedAt || b.startedAt).getTime();
      const tb = new Date(a.endedAt || a.startedAt).getTime();
      return ta - tb;
    });

    return all.slice(0, limit);
  }

  /** Search snapshots by keyword */
  async search(query: string, projectName: string, limit: number = 10): Promise<ScoredSnapshot[]> {
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
    const snapshots = await this.list(projectName, 100);

    const scored: ScoredSnapshot[] = snapshots.map(snap => {
      let score = 0;
      const text = [
        snap.context?.summary || '',
        ...(snap.keys || []),
        ...(snap.context?.decisions || []),
      ].join(' ').toLowerCase();

      for (const kw of keywords) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = (text.match(new RegExp(escaped, 'g')) || []).length;
        score += matches;
      }

      return { ...snap, _score: score };
    });

    return scored
      .filter(s => s._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
  }

  /** Forgetting Curve GC — retention score determines survival */
  async gc(projectName: string, maxAgeDays: number = 30, maxCount: number = 50): Promise<GCResult> {
    const snapshots = await this.list(projectName, 9999);
    let deleted = 0;
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const tiered = { hot: 0, warm: 0, cold: 0 };
    const survivors: Array<{ snap: SessionData; score: number }> = [];

    for (const snap of snapshots) {
      const ts = new Date(snap.endedAt || snap.startedAt).getTime();

      if (ts < cutoff) {
        this._deleteSnapshot(snap);
        deleted++;
        continue;
      }

      const score = calculateRetention(snap);
      const newTier: SnapshotTier = score >= 0.7 ? 'hot' : score >= 0.3 ? 'warm' : 'cold';

      if (snap.tier !== newTier) {
        snap.tier = newTier;
        await this._patchSnapshot(snap, { tier: newTier });
      }

      tiered[newTier]++;
      survivors.push({ snap, score });
    }

    if (survivors.length > maxCount) {
      survivors.sort((a, b) => a.score - b.score);
      const excess = survivors.slice(0, survivors.length - maxCount);
      for (const { snap } of excess) {
        this._deleteSnapshot(snap);
        deleted++;
        tiered[snap.tier]--;
      }
    }

    return { deleted, tiered };
  }

  /** Touch a snapshot — increment access count, update lastAccessed */
  async touch(projectName: string, snapshotId: string): Promise<boolean> {
    const snap = await this.loadById(projectName, snapshotId);
    if (!snap) return false;

    snap.accessCount = (snap.accessCount || 0) + 1;
    snap.lastAccessed = new Date().toISOString();

    const score = calculateRetention(snap);
    snap.tier = score >= 0.7 ? 'hot' : score >= 0.3 ? 'warm' : 'cold';

    await this._patchSnapshot(snap, {
      accessCount: snap.accessCount,
      lastAccessed: snap.lastAccessed,
      tier: snap.tier,
    });
    return true;
  }

  /** Write updated fields back to snapshot file on disk */
  private async _patchSnapshot(snap: SessionData, patch: SnapshotPatch): Promise<void> {
    const dateStr = (snap.endedAt || snap.startedAt || '').split('T')[0];
    if (!dateStr) return;
    const filePath = path.join(this.baseDir, snap.projectName, dateStr, `${snap.id}.json`);
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      Object.assign(data, patch);
      await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logError('snapshot:patch', `${snap.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async _readSnapshot(filePath: string): Promise<SessionData | null> {
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      return migrateSession(JSON.parse(raw) as Partial<SessionData>);
    } catch (e) {
      logError('snapshot:read', `${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private _deleteSnapshot(snap: SessionData): void {
    const dateStr = (snap.endedAt || snap.startedAt || '').split('T')[0];
    if (!dateStr) return;
    const filePath = path.join(this.baseDir, snap.projectName, dateStr, `${snap.id}.json`);
    try { fs.unlinkSync(filePath); } catch (e) { logError('snapshot:delete', e); }
  }

  private _getDateDirs(projectDir: string): string[] {
    try {
      return fs.readdirSync(projectDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(projectDir, d.name))
        .sort()
        .reverse();
    } catch (e) {
      logError('snapshot:getDateDirs', e);
      return [];
    }
  }
}
