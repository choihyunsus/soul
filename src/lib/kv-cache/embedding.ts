// Soul KV-Cache v9.0 — Embedding engine. Vector embeddings via Ollama.
import http from 'http';
import type { SessionData } from './schema';

interface EmbeddingConfig {
  model?: string;
  endpoint?: string;
}

interface VectorCandidate {
  id: string;
  vector: number[];
}

interface SimilarityResult {
  id: string;
  score: number;
}

interface OllamaResponse {
  embedding?: number[];
  embeddings?: number[][];
}

/**
 * Embedding engine for semantic search via Ollama local API.
 * Converts text to vector embeddings and computes cosine similarity.
 */
export class EmbeddingEngine {
  private readonly model: string;
  private readonly endpoint: string;
  public dimensions: number | null;
  private _available: boolean | null;

  constructor(config: EmbeddingConfig = {}) {
    this.model = config.model || 'nomic-embed-text';
    this.endpoint = config.endpoint || 'http://127.0.0.1:11434';
    this.dimensions = null;
    this._available = null;
  }

  /** Check if Ollama is available and the model supports embeddings */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      const vec = await this.embed('test');
      this._available = vec.length > 0;
      this.dimensions = vec.length;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  /** Generate embedding vector for text */
  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) return [];

    const input = text.length > 2000 ? text.slice(0, 2000) : text;

    for (const apiPath of ['/api/embeddings', '/api/embed']) {
      try {
        const body = apiPath === '/api/embeddings'
          ? { model: this.model, prompt: input }
          : { model: this.model, input: input };

        const result = await this._post(apiPath, body) as OllamaResponse;

        if (result.embedding && Array.isArray(result.embedding)) {
          this.dimensions = result.embedding.length;
          return result.embedding;
        }
        if (result.embeddings && Array.isArray(result.embeddings) && result.embeddings[0]) {
          this.dimensions = result.embeddings[0].length;
          return result.embeddings[0];
        }
      } catch {
        continue;
      }
    }
    return [];
  }

  /** Generate embeddings for multiple texts in batch */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /** Compute cosine similarity between two vectors */
  cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += (a[i] ?? 0) * (b[i] ?? 0);
      normA += (a[i] ?? 0) * (a[i] ?? 0);
      normB += (b[i] ?? 0) * (b[i] ?? 0);
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /** Search for the most similar vectors to a query vector */
  rankBySimilarity(
    queryVec: number[],
    candidates: VectorCandidate[],
    topK: number = 10,
    threshold: number = 0.3,
  ): SimilarityResult[] {
    if (!queryVec || queryVec.length === 0 || candidates.length === 0) return [];

    return candidates
      .map(c => ({ id: c.id, score: this.cosineSimilarity(queryVec, c.vector) }))
      .filter(c => c.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Create a searchable text from a snapshot for embedding */
  snapshotToText(snapshot: SessionData): string {
    const parts: string[] = [];
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

  /** HTTP POST helper for Ollama API */
  private _post(apiPath: string, body: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: apiPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      };

      const req = http.request(options, res => {
        let data = '';
        const MAX_RESPONSE = 10 * 1024 * 1024; // 10MB safety limit
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.length > MAX_RESPONSE) {
            req.destroy();
            reject(new Error('Ollama response exceeded 10MB safety limit'));
          }
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Ollama ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
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
