// assembler.js — 4-Layer paging algorithm for automatic AI context assembly
// Arachne's core value: "Automatically selects the code AI needs right now"
const path = require('path');
const fs = require('fs');

class Assembler {
    /**
     * @param {import('./store').Store} store
     * @param {import('./search').BM25Search} search
     * @param {object} assemblyConfig - config.assembly object
     */
    constructor(store, search, assemblyConfig) {
        this._store = store;
        this._search = search;
        this._config = assemblyConfig || {};
        this._defaultBudget = this._config.defaultBudget || 40000;
        this._layers = this._config.layers || {
            fixed: 0.10,
            shortTerm: 0.30,
            associative: 0.40,
            spare: 0.20,
        };
        this._depthLimit = this._config.dependencyDepth || 2;
        this._vectorStore = null;
    }

    /**
     * Connect VectorStore (Phase 3 semantic search)
     * @param {import('./vector-store').VectorStore} vectorStore
     */
    setVectorStore(vectorStore) {
        this._vectorStore = vectorStore;
    }

    /**
     * Main context assembly function
     * @param {string} query - User query (natural language)
     * @param {object} [options]
     * @param {string} [options.activeFile] - Current active file (relative path)
     * @param {number} [options.budget] - Token budget
     * @param {string[]} [options.layers] - Layers to use (default: all)
     * @param {string} [options.projectDir] - Project directory
     * @returns {{context: string, metadata: object}}
     */
    async assemble(query, options = {}) {
        const safeQuery = (query && typeof query === 'string') ? query : '';
        const budget = options.budget || this._defaultBudget;
        const enabledLayers = options.layers || ['fixed', 'shortTerm', 'associative', 'spare'];
        const projectDir = options.projectDir || this._store.getMeta('project_dir') || process.cwd();

        const layerResults = {};
        let totalUsed = 0;

        // ── Layer 1: Fixed (file tree) ──
        if (enabledLayers.includes('fixed')) {
            const l1Budget = Math.floor(budget * this._layers.fixed);
            const l1 = this._buildLayer1(projectDir, l1Budget);
            layerResults.fixed = l1;
            totalUsed += l1.tokens;
        }

        // ── Layer 2: Short-term (active file + recent access) ──
        if (enabledLayers.includes('shortTerm')) {
            const l2Budget = Math.floor(budget * this._layers.shortTerm);
            const l2 = this._buildLayer2(options.activeFile, l2Budget, projectDir);
            layerResults.shortTerm = l2;
            totalUsed += l2.tokens;
        }

        // ── Layer 3: Associative (search + dependencies) ── ★core
        if (enabledLayers.includes('associative')) {
            const l3Budget = Math.floor(budget * this._layers.associative);
            const l3 = await this._buildLayer3(safeQuery, options.activeFile, l3Budget);
            layerResults.associative = l3;
            totalUsed += l3.tokens;
        }

        // ── Layer 4: Spare (frequently accessed files) ──
        if (enabledLayers.includes('spare')) {
            const l4Budget = Math.min(
                Math.floor(budget * this._layers.spare),
                budget - totalUsed // Only use remaining budget
            );
            if (l4Budget > 500) { // Only when at least 500 tokens available
                const l4 = this._buildLayer4(l4Budget);
                layerResults.spare = l4;
                totalUsed += l4.tokens;
            }
        }

        // ── Record access log ──
        this._logAccess(safeQuery, options.activeFile, layerResults);

        // ── Lost in the Middle prevention: L1 → L3 → L4 → L2 ──
        const context = this._arrangeOutput(layerResults);

        return {
            context,
            metadata: {
                query: safeQuery,
                budget,
                tokensUsed: totalUsed,
                tokensRemaining: budget - totalUsed,
                layers: Object.fromEntries(
                    Object.entries(layerResults).map(([k, v]) => [k, {
                        tokens: v.tokens,
                        itemCount: v.items?.length || 0,
                    }])
                ),
            },
        };
    }

    // ── Layer Builders ──

    /**
     * Layer 1: Project file tree (for structural overview)
     */
    _buildLayer1(projectDir, budget) {
        const tree = this._generateFileTree(projectDir, 3);
        const tokens = estimateTokens(tree);

        // Reduce depth if over budget
        if (tokens > budget) {
            const shortTree = this._generateFileTree(projectDir, 2);
            const shortTokens = estimateTokens(shortTree);
            if (shortTokens <= budget) {
                return { text: shortTree, tokens: shortTokens, items: [] };
            }
            // Still over budget — truncate
            const truncated = shortTree.slice(0, Math.floor(budget * 3.5));
            return { text: truncated, tokens: estimateTokens(truncated), items: [] };
        }

        return { text: tree, tokens, items: [] };
    }

    /**
     * Layer 2: Active file + recently accessed file chunks
     */
    _buildLayer2(activeFile, budget, projectDir) {
        let text = '';
        let tokens = 0;
        const items = [];

        // 2-1. Full content of active file
        if (activeFile) {
            const fileRecord = this._store.getFileByPath(activeFile);
            if (fileRecord) {
                const fullPath = path.join(projectDir, activeFile);
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const fileTokens = estimateTokens(content);

                    if (fileTokens <= budget * 0.7) { // Use up to 70% of budget
                        text += `\n## Active File: ${activeFile}\n\`\`\`${fileRecord.language || ''}\n${content}\n\`\`\`\n`;
                        tokens += fileTokens;
                        items.push({ type: 'activeFile', path: activeFile, tokens: fileTokens });
                    } else {
                        // File too large — include chunks only
                        const chunks = this._store.getChunksByFileId(fileRecord.id);
                        let chunkText = '';
                        let chunkTokens = 0;
                        for (const chunk of chunks) {
                            if (chunkTokens + chunk.token_count > budget * 0.7) break;
                            chunkText += `// ${chunk.name || chunk.chunk_type} (L${chunk.start_line}-${chunk.end_line})\n${chunk.content}\n\n`;
                            chunkTokens += chunk.token_count;
                        }
                        text += `\n## Active File: ${activeFile} (key chunks)\n\`\`\`${fileRecord.language || ''}\n${chunkText}\`\`\`\n`;
                        tokens += chunkTokens;
                        items.push({ type: 'activeFileChunks', path: activeFile, tokens: chunkTokens });
                    }
                } catch {
                    // File read failure — ignore
                }
            }
        }

        // 2-2. Recently accessed file chunks
        const remaining = budget - tokens;
        if (remaining > 500) {
            const recentFiles = this._store.getRecentFiles(5);
            for (const rf of recentFiles) {
                if (rf.path === activeFile) continue; // Already included
                const chunks = this._store.getChunksByFileId(rf.file_id);
                if (chunks.length === 0) continue;

                // Add only top chunk
                const topChunk = chunks[0];
                const chunkTokens = topChunk.token_count;
                if (tokens + chunkTokens > budget) break;

                text += `\n## Recent File: ${rf.path}\n\`\`\`${topChunk.language || ''}\n${topChunk.content}\n\`\`\`\n`;
                tokens += chunkTokens;
                items.push({ type: 'recentFile', path: rf.path, tokens: chunkTokens });
            }
        }

        return { text, tokens, items };
    }

    /**
     * Layer 3: BM25 search + dependency chain integration ★core
     */
    async _buildLayer3(query, activeFile, budget) {
        let text = '';
        let tokens = 0;
        const items = [];

        // 3-1. Use hybridSearch if semantic enabled, otherwise BM25-only
        let searchResults;
        if (this._vectorStore?.isReady) {
            const hybridResults = await this._search.hybridSearch(query, { topK: 20 });
            searchResults = hybridResults.map(r => ({ chunk: r.chunk, score: r.score }));
        } else {
            searchResults = this._search.search(query, { topK: 20 });
        }
        const depChunks = this._getDependencyChunks(activeFile);
        const merged = this._mergeSearchAndDeps(searchResults, depChunks);

        // 3-2. Select within budget
        for (const item of merged) {
            const chunkTokens = item.chunk.token_count || estimateTokens(item.chunk.content);
            if (tokens + chunkTokens > budget) continue;

            const filePath = item.chunk.file_path;
            const tag = item.source === 'dependency' ? ' [dep]' : '';
            const chunkLabel = item.chunk.name
                ? `${item.chunk.chunk_type}: ${item.chunk.name}`
                : item.chunk.chunk_type;

            text += `\n## ${filePath}:${item.chunk.start_line}-${item.chunk.end_line} [${chunkLabel}]${tag}\n\`\`\`${item.chunk.language || ''}\n${item.chunk.content}\n\`\`\`\n`;
            tokens += chunkTokens;
            items.push({
                type: item.source, path: filePath, chunk: chunkLabel,
                score: item.score, tokens: chunkTokens,
            });
        }

        return { text, tokens, items };
    }

    /** Extract chunks from activeFile's dependency chain */
    _getDependencyChunks(activeFile) {
        if (!activeFile) return [];
        const fileRecord = this._store.getFileByPath(activeFile);
        if (!fileRecord) return [];

        const deps = this._store.getTransitiveDependencies(fileRecord.id, this._depthLimit);
        const depFileIds = deps.filter(d => d.target_file_id).map(d => d.target_file_id);
        return depFileIds.length > 0 ? this._store.getChunksByFileIds(depFileIds) : [];
    }

    /** Merge search results + dependency chunks by score */
    _mergeSearchAndDeps(searchResults, depChunks) {
        const merged = searchResults.map(r => ({ chunk: r.chunk, score: r.score, source: 'search' }));

        const baseDepScore = searchResults.length > 0
            ? searchResults[searchResults.length - 1].score * 0.8 : 1.0;

        for (const chunk of depChunks) {
            const key = `${chunk.file_path}:${chunk.start_line}`;
            if (merged.some(m => `${m.chunk.file_path}:${m.chunk.start_line}` === key)) continue;
            merged.push({ chunk, score: baseDepScore, source: 'dependency' });
        }

        merged.sort((a, b) => b.score - a.score);
        return merged;
    }


    /**
     * Layer 4: Best chunks from frequently accessed files
     */
    _buildLayer4(budget) {
        let text = '';
        let tokens = 0;
        const items = [];

        const frequentFiles = this._store.getMostAccessedFiles(5);

        for (const ff of frequentFiles) {
            const chunks = this._store.getChunksByFileId(ff.file_id);
            if (chunks.length === 0) continue;

            // Representative chunk with smallest token count
            const sortedChunks = [...chunks].sort((a, b) => a.token_count - b.token_count);
            for (const chunk of sortedChunks) {
                if (tokens + chunk.token_count > budget) break;
                text += `\n## ${ff.path}:${chunk.start_line}-${chunk.end_line} [${chunk.name || chunk.chunk_type}] (freq: ${ff.access_count})\n\`\`\`${chunk.language || ''}\n${chunk.content}\n\`\`\`\n`;
                tokens += chunk.token_count;
                items.push({
                    type: 'frequent',
                    path: ff.path,
                    chunk: chunk.name || chunk.chunk_type,
                    accessCount: ff.access_count,
                    tokens: chunk.token_count,
                });
                break; // Only 1 per file
            }
        }

        return { text, tokens, items };
    }

    // ── Output Arrangement ──

    /**
     * Lost in the Middle prevention: important content at beginning/end, less important in middle
     * Order: L1(structure) → L3(associative/search) → L4(frequent) → L2(active file)
     */
    _arrangeOutput(layerResults) {
        const sections = [];

        // L1: Project structure (front — overall comprehension)
        if (layerResults.fixed?.text) {
            sections.push(`# 📁 Project Structure\n${layerResults.fixed.text}`);
        }

        // L3: Related code (front — key information)
        if (layerResults.associative?.text) {
            sections.push(`# 🔗 Related Code\n${layerResults.associative.text}`);
        }

        // L4: Frequently accessed (middle)
        if (layerResults.spare?.text) {
            sections.push(`# 📊 Frequently Referenced Code\n${layerResults.spare.text}`);
        }

        // L2: Active file (back — most recent context)
        if (layerResults.shortTerm?.text) {
            sections.push(`# 📄 Current Work Context\n${layerResults.shortTerm.text}`);
        }

        return sections.join('\n---\n');
    }

    // ── Utilities ──

    /**
     * Generate project file tree (DB-based)
     */
    _generateFileTree(projectDir, maxDepth) {
        const files = this._store.getAllFiles();
        if (files.length === 0) return '(no indexed files)';

        // Build tree structure
        const tree = {};
        for (const f of files) {
            const parts = f.path.split('/');
            if (parts.length - 1 > maxDepth) continue; // Depth limit

            let node = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    // File (leaf node)
                    node[part] = { _file: true, _lang: f.language, _chunks: f.chunk_count };
                } else {
                    // Directory
                    if (!node[part]) node[part] = {};
                    node = node[part];
                }
            }
        }

        // Tree → text
        return this._renderTree(tree, '', true);
    }

    _renderTree(node, prefix, isRoot) {
        const lines = [];
        const entries = Object.entries(node).filter(([k]) => !k.startsWith('_'));
        entries.sort((a, b) => {
            // Directories first
            const aIsDir = !a[1]._file;
            const bIsDir = !b[1]._file;
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
            return a[0].localeCompare(b[0]);
        });

        for (let i = 0; i < entries.length; i++) {
            const [name, child] = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
            const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

            if (child._file) {
                lines.push(`${prefix}${connector}${name}`);
            } else {
                lines.push(`${prefix}${connector}${name}/`);
                lines.push(this._renderTree(child, childPrefix, false));
            }
        }

        return lines.filter(Boolean).join('\n');
    }

    /**
     * Record file access during assembly
     */
    _logAccess(query, activeFile, layerResults) {
        try {
            // Record active file access
            if (activeFile) {
                const fileRecord = this._store.getFileByPath(activeFile);
                if (fileRecord) {
                    this._store.logAccess(fileRecord.id, query);
                }
            }

            // Record files used in Layer 3
            if (layerResults.associative?.items) {
                const loggedPaths = new Set();
                for (const item of layerResults.associative.items) {
                    if (loggedPaths.has(item.path)) continue;
                    loggedPaths.add(item.path);
                    const fileRecord = this._store.getFileByPath(item.path);
                    if (fileRecord) {
                        this._store.logAccess(fileRecord.id, query);
                    }
                }
            }
        } catch {
            // Access log failure is non-fatal
        }
    }
}

/**
 * Estimate token count (without exact tokenizer)
 * English: ~4 chars = 1 token, Korean: ~2 chars = 1 token, Code: ~3.5 chars = 1 token
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
}

module.exports = { Assembler, estimateTokens };
