// Soul KV-Cache v9.0 — Universal agent session schema. Model-agnostic, distribution-ready.
import crypto from 'crypto';
import type { SnapshotTier } from '../../types';

/** Schema version — increment on breaking changes to session structure. */
export const SCHEMA_VERSION = 2;

export type AgentType = 'mcp' | 'browser' | 'external';

export interface SessionContext {
  summary: string;
  decisions: string[];
  filesChanged: (string | { path: string; desc?: string })[];
  todo: string[];
}

export interface SessionData {
  schemaVersion: number;
  id: string;
  agentName: string;
  agentType: AgentType;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  tokenEstimate: number;
  keys: string[];
  context: SessionContext;
  parentSessionId: string | null;
  projectName: string;
  accessCount: number;
  lastAccessed: string;
  importance: number;
  tier: SnapshotTier;
}

export interface SessionInput {
  id?: string;
  agentName?: string;
  agentType?: string;
  model?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  turnCount?: number;
  tokenEstimate?: number;
  keys?: string[];
  context?: Partial<SessionContext>;
  parentSessionId?: string | null;
  projectName?: string;
  accessCount?: number;
  lastAccessed?: string;
  importance?: number;
  tier?: SnapshotTier;
}

/** Validates and creates a normalized agent session object */
export function createSession(input: SessionInput = {}): SessionData {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id || crypto.randomUUID(),
    agentName: input.agentName || 'unknown',
    agentType: validateAgentType(input.agentType),
    model: input.model || null,
    startedAt: input.startedAt || now,
    endedAt: input.endedAt || null,
    turnCount: input.turnCount || 0,
    tokenEstimate: input.tokenEstimate || 0,
    keys: Array.isArray(input.keys) ? input.keys : [],
    context: normalizeContext(input.context),
    parentSessionId: input.parentSessionId || null,
    projectName: input.projectName || 'default',
    accessCount: input.accessCount || 0,
    lastAccessed: input.lastAccessed || now,
    importance: input.importance ?? 0.5,
    tier: input.tier || 'warm',
  };
}

/** Validates agent type string */
export function validateAgentType(type: string | undefined): AgentType {
  const valid: AgentType[] = ['mcp', 'browser', 'external'];
  return valid.includes(type as AgentType) ? type as AgentType : 'external';
}

/** Normalizes context object with safe defaults */
export function normalizeContext(ctx?: Partial<SessionContext>): SessionContext {
  const c = ctx || {};
  return {
    summary: c.summary || '',
    decisions: Array.isArray(c.decisions) ? c.decisions : [],
    filesChanged: Array.isArray(c.filesChanged) ? c.filesChanged : [],
    todo: Array.isArray(c.todo) ? c.todo : [],
  };
}

/** Merges two sessions (continuing from a parent session) */
export function mergeSession(parent: SessionData, child: SessionInput): SessionData {
  const merged = createSession(child);
  merged.parentSessionId = parent.id;

  const keySet = new Set([...parent.keys, ...merged.keys]);
  merged.keys = Array.from(keySet);

  const parentTodo = (parent.context?.todo || []).filter(Boolean);
  const childTodo = merged.context.todo;
  const todoSet = new Set([...parentTodo, ...childTodo]);
  merged.context.todo = Array.from(todoSet);

  return merged;
}

/** Migrates a snapshot from older schema versions to current */
export function migrateSession(snapshot: Partial<SessionData> | null): SessionData {
  if (!snapshot) return createSession();
  const version = snapshot.schemaVersion || 0;

  if (version < 1) {
    snapshot.schemaVersion = 1;
    if (!snapshot.context) snapshot.context = normalizeContext({});
  }

  if (version < 2) {
    snapshot.schemaVersion = 2;
    snapshot.accessCount = snapshot.accessCount || 0;
    snapshot.lastAccessed = snapshot.lastAccessed || snapshot.endedAt || snapshot.startedAt || new Date().toISOString();
    snapshot.importance = snapshot.importance ?? 0.5;
    snapshot.tier = snapshot.tier || 'warm';
  }

  return snapshot as SessionData;
}
