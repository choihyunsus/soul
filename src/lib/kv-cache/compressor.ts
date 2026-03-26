// Soul KV-Cache v9.0 — Context compressor. Reduces documents to key-value pairs.
import { extractKeywords } from './agent-adapter';
import type { SessionData } from './schema';

interface CompressionResult {
  keys: string[];
  compressed: string;
  ratio: number;
}

interface ScoredSentence {
  sentence: string;
  score: number;
  index: number;
}

/** Compresses full text into a structured KV representation. No LLM call. */
export function compress(text: string, targetTokens: number = 1000): CompressionResult {
  if (!text || text.length === 0) {
    return { keys: [], compressed: '', ratio: 1 };
  }

  const keys = extractKeywords(text, 15);
  const sentences = splitSentences(text);
  const scored = scoreSentences(sentences, keys);

  const maxChars = targetTokens * 3;
  let charCount = 0;
  const selected: ScoredSentence[] = [];

  for (const item of scored) {
    if (charCount + item.sentence.length > maxChars) break;
    selected.push(item);
    charCount += item.sentence.length;
  }

  selected.sort((a, b) => a.index - b.index);
  const compressed = selected.map(s => s.sentence).join(' ');

  return {
    keys,
    compressed,
    ratio: text.length > 0 ? Math.round((compressed.length / text.length) * 100) / 100 : 1,
  };
}

/** Decompresses a snapshot context into readable format */
export function decompress(snapshot: SessionData | null): string {
  if (!snapshot) return '';

  const parts: string[] = [];

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

/** Splits text into sentences. Handles Korean and English. */
export function splitSentences(text: string): string[] {
  const byLines = text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 5);
  const result: string[] = [];

  for (const line of byLines) {
    if (line.length < 150) {
      result.push(line);
      continue;
    }
    // Korean sentence enders + English .!?
    const parts = line.split(/(?<=[.!?])\s+|(?<=(?:습니다|입니다|했다|됐다|한다|됩니다|합니다|있다|없다|이다|된다|해야|할것|하자|함\.|음\.|됨\.))\s*/);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed.length > 5) result.push(trimmed);
    }
  }
  return result;
}

/** Scores sentences by keyword relevance */
export function scoreSentences(sentences: string[], keywords: string[]): ScoredSentence[] {
  const scored = sentences.map((sentence, index): ScoredSentence => {
    const lower = sentence.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = (lower.match(new RegExp(escaped, 'g')) || []).length;
      score += matches;
    }

    if (index === 0) score += 2;
    if (index === sentences.length - 1) score += 1;
    if (sentence.length < 100) score += 0.5;

    return { sentence, score, index };
  });

  return scored.sort((a, b) => b.score - a.score);
}
