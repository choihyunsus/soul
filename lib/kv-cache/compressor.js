// Soul KV-Cache — Context compressor. Reduces documents to key-value pairs.
const { extractKeywords } = require('./agent-adapter');

/**
 * Compresses full text into a structured KV representation.
 * No LLM call — uses pattern-based extractive summarization.
 *
 * @param {string} text - Full document text
 * @param {number} targetTokens - Target compressed size in estimated tokens
 * @returns {{ keys: string[], compressed: string, ratio: number }}
 */
function compress(text, targetTokens = 1000) {
    if (!text || text.length === 0) {
        return { keys: [], compressed: '', ratio: 1 };
    }

    const keys = extractKeywords(text, 15);
    const sentences = splitSentences(text);
    const scored = scoreSentences(sentences, keys);

    // Select top sentences until we hit token budget
    const maxChars = targetTokens * 3; // conservative char-to-token ratio
    let charCount = 0;
    const selected = [];

    for (const item of scored) {
        if (charCount + item.sentence.length > maxChars) break;
        selected.push(item);
        charCount += item.sentence.length;
    }

    // Re-order by original position for readability
    selected.sort((a, b) => a.index - b.index);
    const compressed = selected.map(s => s.sentence).join(' ');

    return {
        keys,
        compressed,
        ratio: text.length > 0 ? Math.round((compressed.length / text.length) * 100) / 100 : 1,
    };
}

/**
 * Decompresses a snapshot context into readable format.
 *
 * @param {object} snapshot - KV-Cache session object
 * @returns {string} Human-readable context
 */
function decompress(snapshot) {
    if (!snapshot) return '';

    const parts = [];

    if (snapshot.keys?.length > 0) {
        parts.push(`Keywords: ${snapshot.keys.join(', ')}`);
    }
    if (snapshot.context?.summary) {
        parts.push(`Summary: ${snapshot.context.summary}`);
    }
    if (snapshot.context?.decisions?.length > 0) {
        parts.push(`Decisions:\n${snapshot.context.decisions.map(d => `  - ${d}`).join('\n')}`);
    }
    if (snapshot.context?.todo?.length > 0) {
        parts.push(`TODO:\n${snapshot.context.todo.map(t => `  - ${t}`).join('\n')}`);
    }

    return parts.join('\n\n');
}

/**
 * Splits text into sentences. Handles Korean and English.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
    // First split by line breaks (most reliable for Korean docs)
    const byLines = text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 5);

    // Then split long lines by sentence boundaries
    const result = [];
    for (const line of byLines) {
        if (line.length < 150) {
            result.push(line);
            continue;
        }
        // Korean sentence enders (da/yo/ham/eum/dwem/seumnida/imnida/haetda/dwaetda/ida/handa)
        // English: .!?
        const parts = line.split(/(?<=[.!?])\s+|(?<=(?:습니다|입니다|했다|됐다|한다|됩니다|합니다|있다|없다|이다|된다|한다|해야|할것|하자|함\.|음\.|됨\.))\s*/);
        for (const p of parts) {
            const trimmed = p.trim();
            if (trimmed.length > 5) result.push(trimmed);
        }
    }
    return result;
}

/**
 * Scores sentences by keyword relevance.
 *
 * @param {string[]} sentences
 * @param {string[]} keywords
 * @returns {{ sentence: string, score: number, index: number }[]}
 */
function scoreSentences(sentences, keywords) {
    const scored = sentences.map((sentence, index) => {
        const lower = sentence.toLowerCase();
        let score = 0;

        for (const kw of keywords) {
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const matches = (lower.match(new RegExp(escaped, 'g')) || []).length;
            score += matches;
        }

        // Bonus for first/last sentences (usually most informative)
        if (index === 0) score += 2;
        if (index === sentences.length - 1) score += 1;

        // Bonus for shorter sentences (more likely to be conclusions)
        if (sentence.length < 100) score += 0.5;

        return { sentence, score, index };
    });

    // Sort by score descending
    return scored.sort((a, b) => b.score - a.score);
}

module.exports = { compress, decompress, splitSentences, scoreSentences };
