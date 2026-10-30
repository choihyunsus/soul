// Scoped study and reviewed-lesson MCP tools; no direct digest, votes or Clotho execution.
import type { z as Zod } from 'zod';
import type { McpToolServer, SoulConfig } from '../types';
import { getAgentName } from '../lib/context';
import { LessonStore } from '../lib/mimir-learning';
import type { Scope, Review } from '../lib/mimir-learning';
import { StudyStore } from '../lib/mimir-study';
import { redactMemory } from '../lib/recall';
import { scopedMimirRecall } from '../lib/mimir-recall';

const result = async (fn: () => unknown) => {
  try { return { content: [{ type: 'text', text: redactMemory(JSON.stringify(await fn())) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: redactMemory(error instanceof Error ? error.message : String(error)) }] }; }
};

export function registerLearningTools(server: McpToolServer, z: typeof Zod, config: SoulConfig): void {
  const lessons = new LessonStore(config.DATA_DIR), studies = new StudyStore(config.DATA_DIR);
  const scope = { project: z.string().min(1), agent: z.string().optional() };
  const owner = (i: { project: string; agent?: string }): Scope => ({ project: i.project, agent: i.agent ?? getAgentName() });
  const requestId = z.string().min(1).describe('Stable unique operation ID; reuse exactly on retries');
  server.tool('n2_mimir_recall', 'Read historical reports and reviewed lessons for one project and agent; no learning mutations.',
    { ...scope, query: z.string().max(12000).optional() },
    async (i: { project: string; agent?: string; query?: string }) => result(() => {
      const s = owner(i); return scopedMimirRecall(config.DATA_DIR, s.project, s.agent, i.query);
    }));
  server.tool('n2_mimir_lesson_propose', 'Create a dormant lesson candidate with source experience IDs. No automatic promotion.',
    { ...scope, requestId, description: z.string().min(1).max(4000), sourceIds: z.array(z.string()).min(1).max(20) },
    async (i: { project: string; agent?: string; requestId: string; description: string; sourceIds: string[] }) => result(() => lessons.propose({ ...i, ...owner(i) })));
  server.tool('n2_mimir_lesson_evidence', 'Record application evidence from data/evidence/<project>/<artifact>. Requires soul-evidence/v1 JSON, matching lesson/work identity, completed durable work, method, observation, outcome and applied flag. Checks provenance/integrity, not the truth of authored observations.',
    { ...scope, requestId, lessonId: z.string(), sessionId: z.string(), artifact: z.string().max(1000) },
    async (i: { project: string; agent?: string; requestId: string; lessonId: string; sessionId: string; artifact: string }) => result(() => lessons.addEvidence({ ...i, ...owner(i) })));
  server.tool('n2_mimir_lesson_review', 'Promote only after two distinct completed-work positive applied results, >=80% positive, no negative result, unchanged sources/artifacts and review of all current user corrections. Hold/retire retain history. Supersession is atomic; no executable rules are created.',
    { ...scope, requestId, lessonId: z.string(), action: z.enum(['promote', 'hold', 'retire']), reason: z.string().min(1), acknowledgedCorrections: z.array(z.string()).optional(), supersedes: z.string().optional() },
    async (i: Omit<Review, 'agent'> & { agent?: string }) => result(() => lessons.review({ ...i, ...owner(i) })));
  server.tool('n2_mimir_lessons', 'Inspect scoped lesson state, recorded evidence, correction IDs and review history. Legacy insights are not implicitly verified.',
    { ...scope, lessonId: z.string().optional() }, async (i: { project: string; agent?: string; lessonId?: string }) => result(() => lessons.list(owner(i), i.lessonId)));
  server.tool('n2_mimir_study_start', 'Start durable scoped study collection. Returns a sessionId; same-topic sessions stay separate.',
    { ...scope, requestId, topic: z.string().min(1).max(500), source: z.string().optional() },
    async (i: { project: string; agent?: string; requestId: string; topic: string; source?: string }) => result(() => studies.start(owner(i), i.requestId, i.topic, i.source ?? 'manual')));
  server.tool('n2_mimir_study_add', 'Append one reported study entry idempotently. Outcome/type are reports, not verified effects or user authority.',
    { ...scope, sessionId: z.string(), entryId: z.string(), action: z.string(), outcome: z.string(), sourceRef: z.string(), type: z.enum(['success', 'failure', 'pattern', 'correction']).optional() },
    async (i: { project: string; agent?: string; sessionId: string; entryId: string; action: string; outcome: string; sourceRef: string; type?: string }) => result(() => studies.add(owner(i), i.sessionId, [i])));
  server.tool('n2_mimir_study_end', 'Freeze and save study reports. Restart-safe retry; no digest, cross-project merge, voting or graduation.',
    { ...scope, sessionId: z.string() }, async (i: { project: string; agent?: string; sessionId: string }) => result(() => studies.end(owner(i), i.sessionId)));
  server.tool('n2_mimir_study_sessions', 'Find unfinished durable study collections in one scope.', scope,
    async (i: { project: string; agent?: string }) => result(() => studies.list(owner(i))));
}
