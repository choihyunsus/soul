// Soul KV-Cache — Embedding engine. Generates and searches vector embeddings via Ollama.
const http = require('http');

/**
 * Embedding engine for semantic search via Ollama local API.
 * Converts text to vector embeddings and computes cosine similarity.
 *
 * Supported models: nomic-embed-text (recommended), qwen3, llama3, etc.
 * Any Ollama model that supports /api/embeddings endpoint works.
 */
class EmbeddingEngine {
    /**
     * @param {object} config - Embedding config from config.KV_CACHE.embedding
     * @param {string} config.model - Ollama model name
     * @param {string} config.endpoint - Ollama endpoint (default: http://127.0.0.1:11434)
     */
    constructor(config = {}) {
        this.model = config.model || 'nomic-embed-text';
        this.endpoint = config.endpoint || 'http://127.0.0.1:11434';
        this.dimensions = null; // Set after first embedding call
        this._available = null; // Cached availability check
    }

    /**
     * Check if Ollama is available and the model supports embeddings.
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        if (this._available !== null) return this._available;
        try {
            const vec = await this.embed('test');
            this._available = vec.length > 0;
            this.dimensions = vec.length;
            return this._available;
        } catch (e) {
            this._available = false;
            return false;
        }
    }

    /**
     * Generate embedding vector for text.
     *
     * @param {string} text - Input text
     * @returns {Promise<number[]>} Embedding vector
     */
    async embed(text) {
        if (!text || text.trim().length === 0) return [];

        // Truncate to ~2000 chars for embedding efficiency
        const input = text.length > 2000 ? text.slice(0, 2000) : text;

        // Try /api/embeddings first (older API), then /api/embed (newer)
        for (const path of ['/api/embeddings', '/api/embed']) {
            try {
                const body = path === '/api/embeddings'
                    ? { model: this.model, prompt: input }
                    : { model: this.model, input: input };

                const result = await this._post(path, body);

                if (result.embedding && Array.isArray(result.embedding)) {
                    this.dimensions = result.embedding.length;
                    return result.embedding;
                }
                if (result.embeddings && Array.isArray(result.embeddings) && result.embeddings[0]) {
                    this.dimensions = result.embeddings[0].length;
                    return result.embeddings[0];
                }
            } catch (e) {
                continue;
            }
        }

        return [];
    }

    /**
     * Generate embeddings for multiple texts in batch.
     *
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async embedBatch(texts) {
        const results = [];
        for (const text of texts) {
            results.push(await this.embed(text));
        }
        return results;
    }

    /**
     * Compute cosine similarity between two vectors.
     *
     * @param {number[]} a
     * @param {number[]} b
     * @returns {number} Similarity score (0-1)
     */
    cosineSimilarity(a, b) {
        if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    /**
     * Search for the most similar vectors to a query vector.
     *
     * @param {number[]} queryVec - Query embedding vector
     * @param {{ id: string, vector: number[] }[]} candidates - Candidate vectors
     * @param {number} topK - Number of results to return
     * @param {number} threshold - Minimum similarity threshold (0-1)
     * @returns {{ id: string, score: number }[]}
     */
    rankBySimilarity(queryVec, candidates, topK = 10, threshold = 0.3) {
        if (!queryVec || queryVec.length === 0 || candidates.length === 0) return [];

        const scored = candidates
            .map(c => ({
                id: c.id,
                score: this.cosineSimilarity(queryVec, c.vector),
            }))
            .filter(c => c.score >= threshold)
            .sort((a, b) => b.score - a.score);

        return scored.slice(0, topK);
    }

    /**
     * Create a searchable text from a snapshot for embedding.
     *
     * @param {object} snapshot - KV-Cache session snapshot
     * @returns {string} Combined text for embedding
     */
    snapshotToText(snapshot) {
        const parts = [];
        if (snapshot.keys?.length > 0) parts.push(snapshot.keys.join(' '));
        if (snapshot.context?.summary) parts.push(snapshot.context.summary);
        if (snapshot.context?.decisions?.length > 0) {
            parts.push(snapshot.context.decisions.join(' '));
        }
        if (snapshot.context?.todo?.length > 0) {
            parts.push(snapshot.context.todo.join(' '));
        }
        return parts.join('. ');
    }

    /**
     * HTTP POST helper for Ollama API.
     *
     * @param {string} path - API path
     * @param {object} body - Request body
     * @returns {Promise<object>} Response JSON
     */
    _post(path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.endpoint);
            const options = {
                hostname: url.hostname,
                port: url.port || 11434,
                path,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000,
            };

            const req = http.request(options, res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        reject(new Error(`Ollama ${res.statusCode}: ${data.slice(0, 200)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Invalid JSON from Ollama: ${data.slice(0, 100)}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Ollama request timed out'));
            });

            req.write(JSON.stringify(body));
            req.end();
        });
    }
}

module.exports = { EmbeddingEngine };
