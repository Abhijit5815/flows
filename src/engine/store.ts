import { z } from 'zod';
import type { Project, Repo } from '../config/project.ts';
import { repoFile } from '../graph/store.ts';
import { FlowSchema } from '../model/flow.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';

const DecisionViewSchema = z.object({ label: z.string(), probs: z.record(z.string(), z.number()), by: z.enum(['decider', 'llm', 'fallback']) });

// What one scan's flow engine produced for one repo. A deletable cache, like the graphs: it is rebuilt from source,
// and what people add lives in the repo's .flows/ (PLAN.md §3).
export const FlowSetSchema = z.object({
  flows: z.array(FlowSchema),
  reasons: z.record(z.string(), z.array(z.string())), // the decision log, by flow id
  // Candidates the engine did not keep; `flow` is the one a person can promote, when the engine could build it.
  rejected: z.array(z.object({ subject: z.string().min(1), name: z.string().min(1), reasons: z.array(z.string()).min(1), flow: FlowSchema.optional() })),
  decisions: z.record(z.string(), z.object({ destructive: DecisionViewSchema, category: DecisionViewSchema })), // "why this flow", by flow id
  unreachable: z.array(z.string()), // graph nodes no entry point leads to
  notes: z.array(z.string()),
  // Phase 3: the live runs the cross-check used, and each source guard (role) with whether a run got past it.
  runs: z.array(z.string()).default([]),
  roles: z.array(z.object({ guard: z.string(), node: z.string(), covered: z.boolean() })).default([]),
  // Phase 7: flows the last scan had and this one doesn't, because the code changed.
  gone: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })).default([]),
});

export type FlowSet = z.infer<typeof FlowSetSchema>;

export const flowsFile = (project: Project, repo: Pick<Repo, 'path' | 'role'>): string => repoFile(project, 'flows', repo);

export const saveFlows = (project: Project, repo: Pick<Repo, 'path' | 'role'>, set: FlowSet): void => writeJsonAtomic(flowsFile(project, repo), FlowSetSchema.parse(set));

export const loadFlows = (project: Project, repo: Repo): FlowSet | undefined => readCache(flowsFile(project, repo), FlowSetSchema);
