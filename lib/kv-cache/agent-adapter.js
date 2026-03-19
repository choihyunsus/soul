// Soul KV-Cache — Agent adapter. Converts browser/MCP sessions to unified KV schema.
const { createSession } = require('./schema');

/**
 * Converts CheckpointManager's CheckpointData to KV-Cache session schema.
 * Source: src/core/executor/checkpoint-resumption.ts
 *
 * @param {object} checkpoint - CheckpointData from CheckpointManager
 * @param {string} projectName
 * @returns {object} Normalized session
 */
function fromCheckpoint(checkpoint, projectName = 'default') {
    const actions = (checkpoint.recentActions || []);
    const decisions = actions
        .filter(a => a.success)
        .map(a => `Turn ${a.turn}: ${a.summary}`);

    return createSession({
        id: checkpoint.id,
        agentName: 'browser-executor',
        agentType: 'browser',
        startedAt: new Date(checkpoint.timestamp).toISOString(),
        turnCount: checkpoint.turnNumber || 0,
        keys: extractKeywords(checkpoint.progressSummary || ''),
        context: {
            summary: checkpoint.progressSummary || '',
            decisions,
            filesChanged: [],
            todo: checkpoint.remainingGoals || [],
        },
        projectName,
    });
}

/**
 * Converts MemoryBridge MemoryNode array to KV-Cache entries.
 * Source: src/core/executor/memory-bridge.ts
 *
 * @param {object[]} nodes - MemoryNode array
 * @param {string} owner - Agent name
 * @param {string} projectName
 * @returns {object} Normalized session
 */
function fromMemoryBridge(nodes, owner = 'browser', projectName = 'default') {
    const allTags = [];
    const summaries = [];

    for (const node of nodes) {
        if (node.tags) allTags.push(...node.tags);
        if (node.content) {
            summaries.push(node.content.slice(0, 200));
        }
    }

    const keySet = new Set(allTags);

    return createSession({
        agentName: owner,
        agentType: 'browser',
        keys: Array.from(keySet),
        context: {
            summary: summaries.join('\n---\n'),
            decisions: [],
            filesChanged: [],
            todo: [],
        },
        projectName,
    });
}

/**
 * Converts MCP n2_work_end session data to KV-Cache schema.
 * Source: soul/sequences/end.js
 *
 * @param {object} workEndData - Data from n2_work_end call
 * @returns {object} Normalized session
 */
function fromMcpSession(workEndData) {
    const d = workEndData || {};
    const filesChanged = [
        ...(d.filesCreated || []).map(f => f.path || f),
        ...(d.filesModified || []).map(f => f.path || f),
        ...(d.filesDeleted || []).map(f => f.path || f),
    ];

    return createSession({
        agentName: d.agent || 'unknown',
        agentType: 'mcp',
        startedAt: d.startedAt,
        keys: extractKeywords(d.summary || ''),
        context: {
            summary: d.summary || '',
            decisions: d.decisions || [],
            filesChanged,
            todo: d.todo || [],
        },
        parentSessionId: d.parentSessionId || null,
        projectName: d.project || 'default',
    });
}

/**
 * Generates a resume prompt from a snapshot within a token budget.
 * Model-agnostic: produces plain text usable by any LLM.
 *
 * @param {object} snapshot - KV-Cache session object
 * @param {number} budgetTokens - Max tokens (estimated)
 * @returns {string} Resume prompt text
 */
function toResumePrompt(snapshot, budgetTokens = 2000) {
    if (!snapshot) return '';

    const lines = [];
    lines.push(`[Previous Session: ${snapshot.agentName} | ${snapshot.startedAt}]`);

    if (snapshot.keys.length > 0) {
        lines.push(`Topics: ${snapshot.keys.join(', ')}`);
    }

    if (snapshot.context.summary) {
        lines.push(`Summary: ${snapshot.context.summary}`);
    }

    if (snapshot.context.decisions.length > 0) {
        lines.push(`Decisions:`);
        for (const d of snapshot.context.decisions) {
            lines.push(`  - ${d}`);
        }
    }

    if (snapshot.context.todo.length > 0) {
        lines.push(`TODO:`);
        for (const t of snapshot.context.todo) {
            lines.push(`  - ${t}`);
        }
    }

    let result = lines.join('\n');

    // Rough trim to token budget (chars/3 as conservative estimate)
    const maxChars = budgetTokens * 3;
    if (result.length > maxChars) {
        result = result.slice(0, maxChars) + '\n...(truncated)';
    }

    return result;
}

/**
 * Simple keyword extraction from text.
 * No LLM needed: uses frequency-based extraction.
 *
 * @param {string} text
 * @param {number} maxKeywords
 * @returns {string[]}
 */
function extractKeywords(text, maxKeywords = 10) {
    if (!text) return [];

    // Common stop words (English + Korean particles)
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at',
        'to', 'for', 'of', 'with', 'by', 'from', 'and', 'or', 'not',
        'this', 'that', 'it', 'as', 'be', 'has', 'have', 'had', 'do',
        'does', 'did', 'will', 'would', 'could', 'should', 'may', 'can',
    ]);

    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w));

    // Frequency count
    const freq = {};
    for (const w of words) {
        freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxKeywords)
        .map(([word]) => word);
}

module.exports = {
    fromCheckpoint,
    fromMemoryBridge,
    fromMcpSession,
    toResumePrompt,
    extractKeywords,
};
