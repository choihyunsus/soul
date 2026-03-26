// Soul KV-Cache v9.0 — Progressive loading. Extracts context at L1/L2/L3 token budgets.
import type { SessionData } from './schema';

interface LevelSpec {
  name: string;
  maxTokens: number;
}

interface LoadResult {
  level: string;
  tokens: number;
  prompt: string;
}

/** Progressive loading levels for KV-Cache context restoration */
export const LEVELS: Record<string, LevelSpec> = {
  L1: { name: 'minimal', maxTokens: 500 },
  L2: { name: 'standard', maxTokens: 2000 },
  L3: { name: 'full', maxTokens: Infinity },
};

/** Extracts context from a snapshot at the specified progressive level */
export function extractAtLevel(snapshot: SessionData | null, level: string = 'L2'): LoadResult {
  if (!snapshot) return { level, tokens: 0, prompt: '' };

  const spec = LEVELS[level] ?? LEVELS['L2']!;
  const lines: string[] = [];

  // L1: Minimal (keywords + TODO)
  lines.push(`[Session: ${snapshot.agentName} | ${(snapshot.endedAt || snapshot.startedAt || '').split('T')[0]}]`);

  if (snapshot.parentSessionId) {
    lines.push(`Chain: ${snapshot.parentSessionId.slice(0, 8)} -> ${snapshot.id.slice(0, 8)}`);
  }
  if (snapshot.keys?.length > 0) {
    lines.push(`Topics: ${snapshot.keys.slice(0, 10).join(', ')}`);
  }
  if (snapshot.context?.todo?.length > 0) {
    lines.push('TODO:');
    for (const t of snapshot.context.todo) lines.push(`  - ${t}`);
  }

  let prompt = lines.join('\n');
  let tokens = estimateTokenCount(prompt);

  if (level === 'L1' || tokens >= spec.maxTokens) {
    return trimToTokenBudget(prompt, tokens, spec.maxTokens, 'L1');
  }

  // L2: Standard (+ summary + decisions)
  if (snapshot.context?.decisions?.length > 0) {
    lines.push('Decisions:');
    for (const d of snapshot.context.decisions) lines.push(`  - ${d}`);
  }
  if (snapshot.context?.summary) {
    lines.push(`Summary: ${snapshot.context.summary}`);
  }

  prompt = lines.join('\n');
  tokens = estimateTokenCount(prompt);

  if (level === 'L2' || tokens >= spec.maxTokens) {
    return trimToTokenBudget(prompt, tokens, spec.maxTokens, 'L2');
  }

  // L3: Full (+ files changed + metadata)
  if (snapshot.context?.filesChanged?.length > 0) {
    lines.push('Files changed:');
    for (const f of snapshot.context.filesChanged) {
      const entry = typeof f === 'string' ? f : `${f.path} — ${f.desc || ''}`;
      lines.push(`  - ${entry}`);
    }
  }

  lines.push(`Agent type: ${snapshot.agentType || 'unknown'}`);
  if (snapshot.model) lines.push(`Model: ${snapshot.model}`);
  if (snapshot.turnCount) lines.push(`Turns: ${snapshot.turnCount}`);
  if (snapshot.tokenEstimate) lines.push(`Token estimate: ${snapshot.tokenEstimate}`);

  prompt = lines.join('\n');
  tokens = estimateTokenCount(prompt);

  return { level: 'L3', tokens, prompt };
}

/** Auto-selects the best progressive level based on available token budget */
export function autoLevel(snapshot: SessionData | null, budgetTokens: number = 2000): LoadResult {
  if (!snapshot) return { level: 'L1', tokens: 0, prompt: '' };

  for (const lvl of ['L3', 'L2', 'L1']) {
    const result = extractAtLevel(snapshot, lvl);
    if (result.tokens <= budgetTokens) return result;
  }

  const l1 = extractAtLevel(snapshot, 'L1');
  return trimToTokenBudget(l1.prompt, l1.tokens, budgetTokens, 'L1');
}

/** Estimates token count for text (model-agnostic) */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
  const asciiCount = text.length - cjkCount;
  return Math.ceil(asciiCount / 4 + cjkCount / 2);
}

/** Trims prompt text to fit within a token budget */
function trimToTokenBudget(
  prompt: string, currentTokens: number, maxTokens: number, level: string,
): LoadResult {
  if (currentTokens <= maxTokens) {
    return { level, tokens: currentTokens, prompt };
  }
  const maxChars = maxTokens * 3;
  const trimmed = prompt.slice(0, maxChars) + '\n...(truncated)';
  return { level, tokens: maxTokens, prompt: trimmed };
}
