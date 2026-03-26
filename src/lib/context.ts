// Soul v9.0 — Session context manager. Replaces global state anti-pattern.

interface SessionContext {
  agentName: string | null;
  kvChain: Record<string, string>;
}

const _ctx: SessionContext = {
  agentName: null,
  kvChain: {},
};

/** Get current session context */
export function getContext(): SessionContext {
  return _ctx;
}

/** Set agent name (called during n2_boot) */
export function setAgentName(name: string): void {
  _ctx.agentName = name;
}

/** Get agent name with fallback */
export function getAgentName(): string {
  return _ctx.agentName || process.env.N2_AGENT_NAME || 'default';
}

/** Set KV chain parent (for session linking) */
export function setKvChainParent(project: string, sessionId: string): void {
  _ctx.kvChain[project] = sessionId;
}

/** Get and consume KV chain parent */
export function popKvChainParent(project: string): string | null {
  const parent = _ctx.kvChain[project] || null;
  delete _ctx.kvChain[project];
  return parent;
}
