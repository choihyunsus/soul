// chunker.js — Split source code into function/class-level chunks
// Phase 1: Regex-based (no parser needed), Phase 2: AST replacement possible

// Default: ~3.5 chars/token for English code
// CJK (Korean/Chinese/Japanese): ~1.5 chars/token (set via config)
let _tokenMultiplier = 3.5;

/**
 * Set token multiplier (called from config)
 * @param {number|object} multiplier — number (global) or {default, ko, zh, ja} per-language
 */
function setTokenMultiplier(multiplier) {
    if (typeof multiplier === 'number' && multiplier > 0) {
        _tokenMultiplier = multiplier;
    }
}

/**
 * Estimate token count (configurable via tokenMultiplier)
 * @param {string} text
 * @param {string} [language] — optional language hint for per-language multiplier
 */
function estimateTokens(text, language) {
    return Math.ceil(text.length / _tokenMultiplier);
}

// Language-specific chunk detection patterns
const CHUNK_PATTERNS = {
    js: [
        { type: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
        { type: 'class', regex: /^(?:export\s+)?class\s+(\w+)/m },
        { type: 'arrow', regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/m },
        { type: 'method', regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/m },
    ],
    ts: [
        { type: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
        { type: 'class', regex: /^(?:export\s+)?class\s+(\w+)/m },
        { type: 'interface', regex: /^(?:export\s+)?interface\s+(\w+)/m },
        { type: 'type', regex: /^(?:export\s+)?type\s+(\w+)/m },
        { type: 'arrow', regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/m },
        { type: 'method', regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/m },
    ],
    py: [
        { type: 'function', regex: /^(?:async\s+)?def\s+(\w+)/m },
        { type: 'class', regex: /^class\s+(\w+)/m },
    ],
    rs: [
        { type: 'function', regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
        { type: 'struct', regex: /^(?:pub\s+)?struct\s+(\w+)/m },
        { type: 'enum', regex: /^(?:pub\s+)?enum\s+(\w+)/m },
        { type: 'impl', regex: /^impl(?:<[^>]+>)?\s+(\w+)/m },
        { type: 'trait', regex: /^(?:pub\s+)?trait\s+(\w+)/m },
    ],
    go: [
        { type: 'function', regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)/m },
        { type: 'struct', regex: /^type\s+(\w+)\s+struct/m },
        { type: 'interface', regex: /^type\s+(\w+)\s+interface/m },
    ],
};

// Extension → pattern mapping
const LANG_MAP = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    ts: 'ts', tsx: 'ts', mts: 'ts',
    py: 'py',
    rs: 'rs',
    go: 'go',
};

/**
 * Find block end using brace matching (JS/TS/Rust/Go)
 */
function findBlockEnd(lines, startIdx) {
    let depth = 0;
    let found = false;

    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{') { depth++; found = true; }
            if (ch === '}') { depth--; }
        }
        if (found && depth <= 0) {
            return i;
        }
    }
    return lines.length - 1;
}

/**
 * Find block end using indentation (Python)
 */
function findIndentEnd(lines, startIdx) {
    if (startIdx >= lines.length - 1) return startIdx;

    const startLine = lines[startIdx];
    const baseIndent = startLine.match(/^(\s*)/)[1].length;

    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const indent = line.match(/^(\s*)/)[1].length;
        if (indent <= baseIndent) {
            return i - 1;
        }
    }
    return lines.length - 1;
}

/**
 * Split source code into chunks
 * @param {string} content - File content
 * @param {string} language - Language (js, ts, py, rs, go)
 * @returns {Array<{type:string, name:string, startLine:number, endLine:number, content:string, tokenCount:number, searchText:string}>}
 */
function chunkCode(content, language) {
    const lang = LANG_MAP[language] || language;
    const patterns = CHUNK_PATTERNS[lang];

    // Unsupported language → entire file as single chunk
    if (!patterns) {
        return [makeWholeFileChunk(content)];
    }

    const lines = content.split('\n');
    const chunks = [];
    const usedLines = new Set();

    // Check each line against patterns
    for (let i = 0; i < lines.length; i++) {
        if (usedLines.has(i)) continue;

        const line = lines[i];

        for (const pattern of patterns) {
            const match = line.match(pattern.regex);
            if (!match) continue;

            const name = match[1] || null;
            const startLine = i + 1; // 1-indexed

            // Find block end
            let endIdx;
            if (lang === 'py') {
                endIdx = findIndentEnd(lines, i);
            } else {
                endIdx = findBlockEnd(lines, i);
            }

            const endLine = endIdx + 1; // 1-indexed
            const chunkContent = lines.slice(i, endIdx + 1).join('\n');
            const tokenCount = estimateTokens(chunkContent);

            // Skip very small chunks (less than 3 lines)
            if (endIdx - i < 2) continue;

            // Mark used lines
            for (let j = i; j <= endIdx; j++) usedLines.add(j);

            chunks.push({
                type: pattern.type,
                name,
                startLine,
                endLine,
                content: chunkContent,
                tokenCount,
                searchText: buildSearchText(name, chunkContent, pattern.type),
            });
            break; // This line matched, move to next line
        }
    }

    // Add uncovered code as "remainder" chunks
    const uncovered = [];
    let rangeStart = null;
    for (let i = 0; i < lines.length; i++) {
        if (!usedLines.has(i)) {
            if (rangeStart === null) rangeStart = i;
        } else {
            if (rangeStart !== null) {
                uncovered.push({ start: rangeStart, end: i - 1 });
                rangeStart = null;
            }
        }
    }
    if (rangeStart !== null) {
        uncovered.push({ start: rangeStart, end: lines.length - 1 });
    }

    // Add large unmatched blocks as "module" chunks
    for (const range of uncovered) {
        const blockContent = lines.slice(range.start, range.end + 1).join('\n').trim();
        if (blockContent.length > 50 && estimateTokens(blockContent) > 30) {
            chunks.push({
                type: 'module',
                name: null,
                startLine: range.start + 1,
                endLine: range.end + 1,
                content: blockContent,
                tokenCount: estimateTokens(blockContent),
                searchText: buildSearchText(null, blockContent, 'module'),
            });
        }
    }

    // Sort by line number
    chunks.sort((a, b) => a.startLine - b.startLine);

    // If no chunks found, treat entire file as one
    if (chunks.length === 0) {
        return [makeWholeFileChunk(content)];
    }

    return chunks;
}

/**
 * Create whole-file chunk (for unsupported languages or match failure)
 */
function makeWholeFileChunk(content) {
    return {
        type: 'module',
        name: null,
        startLine: 1,
        endLine: content.split('\n').length,
        content,
        tokenCount: estimateTokens(content),
        searchText: buildSearchText(null, content, 'module'),
    };
}

/**
 * Build search text for BM25
 */
function buildSearchText(name, content, type) {
    const parts = [type];
    if (name) parts.push(name);
    // Extract identifiers from code (alphanumeric + _)
    const identifiers = content.match(/[a-zA-Z_]\w{2,}/g) || [];
    const unique = [...new Set(identifiers)];
    parts.push(...unique.slice(0, 50)); // Top 50 only
    return parts.join(' ').toLowerCase();
}

/**
 * Detect language from file extension
 */
function detectLanguage(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    return ext;
}

module.exports = { chunkCode, estimateTokens, detectLanguage, setTokenMultiplier, LANG_MAP, CHUNK_PATTERNS };
