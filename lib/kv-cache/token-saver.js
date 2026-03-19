// Soul KV-Cache — Progressive loading. Extracts context at L1/L2/L3 token budgets.
const { extractKeywords } = require('./agent-adapter');

/**
 * Progressive loading levels for KV-Cache context restoration.
 * Lower levels use fewer tokens but provide less context.
 *
 * L1: Minimal — keywords + TODO only (~500 tokens)
 * L2: Standard — L1 + compressed summary + decisions (~2000 tokens)
 * L3: Full — complete uncompressed context (no limit)
 */
const LEVELS = {
    L1: { name: 'minimal', maxTokens: 500 },
    L2: { name: 'standard', maxTokens: 2000 },
    L3: { name: 'full', maxTokens: Infinity },
};

/**
 * Extracts context from a snapshot at the specified progressive level.
 *
 * @param {object} snapshot - KV-Cache session snapshot
 * @param {string} level - 'L1', 'L2', or 'L3'
 * @returns {{ level: string, tokens: number, prompt: string }}
 */
function extractAtLevel(snapshot, level = 'L2') {
    if (!snapshot) return { level, tokens: 0, prompt: '' };

    const spec = LEVELS[level] || LEVELS.L2;
    const lines = [];

    // --- L1: Minimal (keywords + TODO) ---
    lines.push(`[Session: ${snapshot.agentName} | ${(snapshot.endedAt || snapshot.startedAt || '').split('T')[0]}]`);

    if (snapshot.parentSessionId) {
        lines.push(`Chain: ${snapshot.parentSessionId.slice(0, 8)} -> ${snapshot.id.slice(0, 8)}`);
    }

    if (snapshot.keys?.length > 0) {
        lines.push(`Topics: ${snapshot.keys.slice(0, 10).join(', ')}`);
    }

    if (snapshot.context?.todo?.length > 0) {
        lines.push('TODO:');
        for (const t of snapshot.context.todo) {
            lines.push(`  - ${t}`);
        }
    }

    let prompt = lines.join('\n');
    let tokens = estimateTokenCount(prompt);

    if (level === 'L1' || tokens >= spec.maxTokens) {
        return trimToTokenBudget(prompt, tokens, spec.maxTokens, 'L1');
    }

    // --- L2: Standard (+ summary + decisions) ---
    if (snapshot.context?.decisions?.length > 0) {
        lines.push('Decisions:');
        for (const d of snapshot.context.decisions) {
            lines.push(`  - ${d}`);
        }
    }

    if (snapshot.context?.summary) {
        lines.push(`Summary: ${snapshot.context.summary}`);
    }

    prompt = lines.join('\n');
    tokens = estimateTokenCount(prompt);

    if (level === 'L2' || tokens >= spec.maxTokens) {
        return trimToTokenBudget(prompt, tokens, spec.maxTokens, 'L2');
    }

    // --- L3: Full (+ files changed) ---
    if (snapshot.context?.filesChanged?.length > 0) {
        lines.push('Files changed:');
        for (const f of snapshot.context.filesChanged) {
            const entry = typeof f === 'string' ? f : `${f.path} — ${f.desc || ''}`;
            lines.push(`  - ${entry}`);
        }
    }

    // Include raw metadata
    lines.push(`Agent type: ${snapshot.agentType || 'unknown'}`);
    if (snapshot.model) lines.push(`Model: ${snapshot.model}`);
    if (snapshot.turnCount) lines.push(`Turns: ${snapshot.turnCount}`);
    if (snapshot.tokenEstimate) lines.push(`Token estimate: ${snapshot.tokenEstimate}`);

    prompt = lines.join('\n');
    tokens = estimateTokenCount(prompt);

    return { level: 'L3', tokens, prompt };
}

/**
 * Auto-selects the best progressive level based on available token budget.
 * Starts from L3 and downgrades until it fits.
 *
 * @param {object} snapshot - KV-Cache session snapshot
 * @param {number} budgetTokens - Available token budget
 * @returns {{ level: string, tokens: number, prompt: string }}
 */
function autoLevel(snapshot, budgetTokens = 2000) {
    if (!snapshot) return { level: 'L1', tokens: 0, prompt: '' };

    // Try from highest to lowest
    for (const lvl of ['L3', 'L2', 'L1']) {
        const result = extractAtLevel(snapshot, lvl);
        if (result.tokens <= budgetTokens) {
            return result;
        }
    }

    // Even L1 is over budget — trim L1
    const l1 = extractAtLevel(snapshot, 'L1');
    return trimToTokenBudget(l1.prompt, l1.tokens, budgetTokens, 'L1');
}

/**
 * Estimates token count for text (model-agnostic).
 * CJK characters ~1 token each, ASCII ~4 chars per token.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokenCount(text) {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
    const asciiCount = text.length - cjkCount;
    return Math.ceil(asciiCount / 4 + cjkCount / 2);
}

/**
 * Trims prompt text to fit within a token budget.
 *
 * @param {string} prompt
 * @param {number} currentTokens
 * @param {number} maxTokens
 * @param {string} level
 * @returns {{ level: string, tokens: number, prompt: string }}
 */
function trimToTokenBudget(prompt, currentTokens, maxTokens, level) {
    if (currentTokens <= maxTokens) {
        return { level, tokens: currentTokens, prompt };
    }
    // Conservative: assume 3 chars per token for trimming
    const maxChars = maxTokens * 3;
    const trimmed = prompt.slice(0, maxChars) + '\n...(truncated)';
    return { level, tokens: maxTokens, prompt: trimmed };
}

module.exports = { extractAtLevel, autoLevel, estimateTokenCount, LEVELS };
