// search.js — BM25 keyword search (lightweight version of QLN router)
// Adapted from QLN Router._stage2BM25 logic, optimized for code search

class BM25Search {
    /**
     * @param {object} store - Store instance
     * @param {object} config - Search config (config.search)
     */
    constructor(store, config) {
        this._store = store;
        this._k1 = config.bm25?.k1 || 1.2;
        this._b = config.bm25?.b || 0.75;
        this._topK = config.topK || 10;
    }

    /**
     * Execute BM25 search
     * @param {string} query - Search query
     * @param {object} [options]
     * @param {number} [options.topK] - Number of results
     * @param {string} [options.language] - Language filter
     * @returns {Array<{chunk: object, score: number}>}
     */
    search(query, options = {}) {
        if (!query || typeof query !== 'string') return [];
        const topK = options.topK || this._topK;
        const terms = this._tokenize(query);
        if (terms.length === 0) return [];

        // Load all chunks (with language filter)
        const chunks = this._loadChunks(options.language);
        if (chunks.length === 0) return [];

        // Calculate document statistics
        const N = chunks.length;
        const avgDl = chunks.reduce((sum, c) => sum + (c.search_text || '').length, 0) / N;

        // Calculate DF (document frequency)
        const df = {};
        for (const term of terms) {
            df[term] = chunks.filter(c => (c.search_text || '').toLowerCase().includes(term)).length;
        }

        // Calculate BM25 scores
        const scored = [];
        for (const chunk of chunks) {
            const doc = (chunk.search_text || '').toLowerCase();
            const dl = doc.length;
            let score = 0;

            for (const term of terms) {
                const tf = this._countOccurrences(doc, term);
                if (tf === 0) continue;
                const idf = Math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1);
                const numerator = tf * (this._k1 + 1);
                const denominator = tf + this._k1 * (1 - this._b + this._b * (dl / avgDl));
                score += idf * (numerator / denominator);
            }

            if (score > 0) {
                score = this._applyBonuses(score, chunk, terms);
                scored.push({ chunk, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    /** Apply filename/function name matching bonuses */
    _applyBonuses(score, chunk, terms) {
        const filePath = (chunk.file_path || '').toLowerCase();
        for (const term of terms) {
            if (filePath.includes(term)) score *= 1.3;
        }
        if (chunk.name) {
            const chunkName = chunk.name.toLowerCase();
            for (const term of terms) {
                if (chunkName.includes(term)) score *= 1.5;
            }
        }
        return score;
    }

    /** Load chunks (with optional language filter) */
    _loadChunks(language) {
        const sql = language
            ? `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.language = ?`
            : `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id`;
        return language ? this._store.db.prepare(sql).all(language) : this._store.db.prepare(sql).all();
    }

    /**
     * Tokenize text
     */
    _tokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\u3131-\uD79D_\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 2);
    }

    /**
     * Count term occurrences in text
     */
    _countOccurrences(text, term) {
        let count = 0;
        let pos = 0;
        while ((pos = text.indexOf(term, pos)) !== -1) {
            count++;
            pos += term.length;
        }
        return count;
    }

    /**
     * Connect VectorStore (Phase 3)
     * @param {import('./vector-store').VectorStore} vectorStore
     */
    setVectorStore(vectorStore) {
        this._vectorStore = vectorStore;
    }

    /**
     * Hybrid search: BM25 + semantic weighted merge
     * @param {string} query
     * @param {object} [options]
     * @param {number} [options.topK=10]
     * @param {number} [options.alpha=0.5] - Semantic weight (0=BM25 only, 1=semantic only)
     * @returns {Promise<Array<{chunk: object, score: number, bm25Score: number, semanticScore: number}>>}
     */
    async hybridSearch(query, options = {}) {
        if (!query || typeof query !== 'string') return [];
        const topK = options.topK || 10;
        const alpha = options.alpha ?? 0.5;

        // BM25 search
        const bm25Results = this.search(query, { topK: topK * 2 });

        // No VectorStore → BM25-only fallback
        if (!this._vectorStore || !this._vectorStore.isReady) {
            return bm25Results.map(r => ({
                chunk: r.chunk,
                score: r.score,
                bm25Score: r.score,
                semanticScore: 0,
            })).slice(0, topK);
        }

        // Semantic search
        const vecResults = await this._vectorStore.search(query, topK * 2);

        // Normalize BM25 scores (0~1)
        const maxBm25 = bm25Results.length > 0 ? bm25Results[0].score : 1;
        const bm25Map = new Map();
        for (const r of bm25Results) {
            bm25Map.set(r.chunk.id, {
                chunk: r.chunk,
                normalizedScore: maxBm25 > 0 ? r.score / maxBm25 : 0,
                rawScore: r.score,
            });
        }

        // Semantic distance → similarity (lower distance = more similar)
        const maxDist = vecResults.length > 0 ? Math.max(...vecResults.map(v => v.distance), 1) : 1;
        const vecMap = new Map();
        for (const v of vecResults) {
            vecMap.set(v.chunkId, maxDist > 0 ? 1 - (v.distance / maxDist) : 0);
        }

        // Merge: collect all candidates
        const allIds = new Set([...bm25Map.keys(), ...vecMap.keys()]);
        const merged = [];

        for (const id of allIds) {
            const bm25Entry = bm25Map.get(id);
            const semanticScore = vecMap.get(id) || 0;
            const bm25Normalized = bm25Entry ? bm25Entry.normalizedScore : 0;

            const hybridScore = (1 - alpha) * bm25Normalized + alpha * semanticScore;

            // Chunk info: use BM25 result if available, otherwise query DB
            let chunk = bm25Entry ? bm25Entry.chunk : null;
            if (!chunk) {
                const row = this._store.db.prepare(
                    `SELECT c.*, f.path as file_path, f.language
                     FROM chunks c JOIN files f ON c.file_id = f.id
                     WHERE c.id = ?`
                ).get(id);
                if (!row) continue;
                chunk = row;
            }

            merged.push({
                chunk,
                score: hybridScore,
                bm25Score: bm25Entry ? bm25Entry.rawScore : 0,
                semanticScore,
            });
        }

        merged.sort((a, b) => b.score - a.score);
        return merged.slice(0, topK);
    }
}

module.exports = { BM25Search };
