// Soul v9.0 — Entity Memory: structured entity tracking for people, places, concepts, etc.
import fs from 'fs';
import path from 'path';
import { readJson, writeJson, nowISO } from './utils';
import type { EntityType } from '../types';

interface StoredEntity {
  type: EntityType;
  name: string;
  attributes: Record<string, string | number | boolean | null>;
  firstSeen: string;
  lastMentioned: string;
  mentionCount: number;
}

interface EntityStore {
  entities: StoredEntity[];
  updatedAt: string;
}

export interface EntityInput {
  type: EntityType;
  name: string;
  attributes?: Record<string, string | number | boolean | null>;
}

interface UpsertResult {
  action: 'created' | 'updated' | 'skip';
  entity: StoredEntity | null;
}

interface BatchResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * EntityMemory — Structured entity tracking and auto-injection.
 * Data path: data/memory/entities.json
 * Entity types: person, hardware, project, concept, place, service
 */
export class EntityMemory {
  private readonly filePath: string;
  private _cache: EntityStore | null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'memory', 'entities.json');
    this._cache = null;
  }

  /** Load entity data (with caching) */
  private _load(): EntityStore {
    if (this._cache) return this._cache;
    const data = readJson<EntityStore>(this.filePath);
    this._cache = data || { entities: [], updatedAt: nowISO() };
    return this._cache;
  }

  /** Save changes + update cache */
  private _save(data: EntityStore): void {
    data.updatedAt = nowISO();
    this._cache = data;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeJson(this.filePath, data);
  }

  /** Add or update an entity (upsert). Merges attributes on match. */
  upsert(entity: EntityInput): UpsertResult {
    if (!entity || !entity.name || !entity.type) {
      return { action: 'skip', entity: null };
    }

    const data = this._load();
    const nameKey = entity.name.toLowerCase().trim();
    const existing = data.entities.find(
      e => e.name.toLowerCase().trim() === nameKey && e.type === entity.type,
    );

    if (existing) {
      existing.attributes = { ...existing.attributes, ...(entity.attributes || {}) };
      existing.lastMentioned = nowISO();
      existing.mentionCount = (existing.mentionCount || 1) + 1;
      this._save(data);
      return { action: 'updated', entity: existing };
    }

    const newEntity: StoredEntity = {
      type: entity.type,
      name: entity.name,
      attributes: entity.attributes || {},
      firstSeen: nowISO(),
      lastMentioned: nowISO(),
      mentionCount: 1,
    };
    data.entities.push(newEntity);
    this._save(data);
    return { action: 'created', entity: newEntity };
  }

  /** Batch upsert multiple entities */
  upsertBatch(entities: EntityInput[]): BatchResult {
    if (!Array.isArray(entities)) return { created: 0, updated: 0, skipped: 0 };
    const stats: BatchResult = { created: 0, updated: 0, skipped: 0 };
    for (const e of entities) {
      const result = this.upsert(e);
      if (result.action === 'created') stats.created++;
      else if (result.action === 'updated') stats.updated++;
      else stats.skipped++;
    }
    return stats;
  }

  /** Get entity by name */
  get(name: string): StoredEntity | null {
    const data = this._load();
    const nameKey = name.toLowerCase().trim();
    return data.entities.find(e => e.name.toLowerCase().trim() === nameKey) || null;
  }

  /** Get entities by type */
  getByType(type: EntityType): StoredEntity[] {
    const data = this._load();
    return data.entities.filter(e => e.type === type);
  }

  /** Search entities by keyword */
  search(query: string): StoredEntity[] {
    const data = this._load();
    const keywords = query.toLowerCase().split(/\s+/);
    return data.entities.filter(e => {
      const text = [e.name, e.type, JSON.stringify(e.attributes)].join(' ').toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
  }

  /** List all entities */
  list(): StoredEntity[] {
    return this._load().entities;
  }

  /** Remove entity by name (optionally filter by type) */
  remove(name: string, type?: EntityType): boolean {
    const data = this._load();
    const nameKey = name.toLowerCase().trim();
    const before = data.entities.length;
    data.entities = data.entities.filter(e => {
      const match = e.name.toLowerCase().trim() === nameKey;
      if (type) return !(match && e.type === type);
      return !match;
    });
    if (data.entities.length < before) {
      this._save(data);
      return true;
    }
    return false;
  }

  /** Prune old entities (not mentioned for maxAge days) */
  prune(maxAgeDays: number = 90): number {
    const data = this._load();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const before = data.entities.length;
    data.entities = data.entities.filter(e => {
      const last = new Date(e.lastMentioned || e.firstSeen).getTime();
      return last >= cutoff;
    });
    if (data.entities.length < before) {
      this._save(data);
    }
    return before - data.entities.length;
  }

  /** Generate context string for boot injection */
  toContext(maxItems: number = 10): string {
    const data = this._load();
    if (data.entities.length === 0) return '';

    const sorted = [...data.entities]
      .sort((a, b) => (b.mentionCount || 0) - (a.mentionCount || 0))
      .slice(0, maxItems);

    const lines = sorted.map(e => {
      const attrs = Object.entries(e.attributes || {})
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      return `${e.name}[${e.type}]${attrs ? ': ' + attrs : ''}`;
    });

    return `Entities(${data.entities.length}): ${lines.join(' | ')}`;
  }

  /** Invalidate cache (for testing/reload) */
  invalidateCache(): void {
    this._cache = null;
  }
}
