// Stable caller-chosen identities. No aliases, persona, or cross-agent merging.
import { memorySegment } from './kv-cache/atomic-json';
export function canonicalAgent(agent: string): string { return memorySegment(agent); }
