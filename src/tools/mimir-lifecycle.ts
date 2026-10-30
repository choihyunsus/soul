// Soul lifecycle: scoped read-only recall and durable report collection.
// Learning, voting, graduation, and rule generation are separate operations.
import { logError } from '../lib/utils';
import { recordWorkReports, scopedMimirContext } from '../lib/mimir-scope';
import type { WorkReport } from '../lib/mimir-scope';
import type { SoulConfig } from '../types';

// Keep the optional factory for existing callers; reads never initialize the legacy engine.
export async function mimirActivate(config: SoulConfig, project: string, agent: string, _factory?: unknown): Promise<string> {
  try { return scopedMimirContext(config.DATA_DIR, project, agent); }
  catch (error) { logError('mimir:activate', error); return ''; }
}
export async function mimirRecall(config: SoulConfig, task: string, project: string, agent: string, _factory?: unknown): Promise<string> {
  if (!task.trim()) return '';
  try { return scopedMimirContext(config.DATA_DIR, project, agent, task); }
  catch (error) { logError('mimir:recall', error); return ''; }
}
// Name retained for compatibility. Collection does not imply verified learning.
export async function mimirDigest(config: SoulConfig, project: string, agent: string, report: WorkReport, _factory?: unknown): Promise<string> {
  const result = recordWorkReports(config.DATA_DIR, project, agent, report);
  return `Mimir reports saved: ${result.inserted} new, ${result.duplicates} already saved. No outcome inference, votes, graduation, or rule generation.`;
}
