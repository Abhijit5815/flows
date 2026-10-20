import { z } from 'zod';
import type { Project, Repo } from '../config/project.ts';
import { repoFile } from '../graph/store.ts';
import { FlowSchema } from '../model/flow.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';

// What one scan's flow engine produced for one repo. A deletable cache, like the graphs: it is rebuilt from source,
// and the reviewer's verdicts live in the repo's rules (PLAN.md §13: SQLite comes with Phase 5).
export const FlowSetSchema = z.object({
  flows: z.array(FlowSchema),
  reasons: z.record(z.string(), z.array(z.string())), // the decision log, by flow id
  rejected: z.array(z.object({ subject: z.string().min(1), name: z.string().min(1), reasons: z.array(z.string()).min(1) })),
  unreachable: z.array(z.string()), // graph nodes no entry point leads to
  notes: z.array(z.string()),
});

export type FlowSet = z.infer<typeof FlowSetSchema>;

export const flowsFile = (project: Project, repo: Pick<Repo, 'path' | 'role'>): string => repoFile(project, 'flows', repo);

export const saveFlows = (project: Project, repo: Pick<Repo, 'path' | 'role'>, set: FlowSet): void => writeJsonAtomic(flowsFile(project, repo), FlowSetSchema.parse(set));

export const loadFlows = (project: Project, repo: Repo): FlowSet | undefined => readCache(flowsFile(project, repo), FlowSetSchema);
