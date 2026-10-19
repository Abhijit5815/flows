import { join } from 'node:path';
import { projectDataDir, type Project, type Repo } from '../config/project.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';
import { GraphSchema, type Graph } from './schema.ts';

// Graphs live in the deletable cache, one file per registered repo and role; `flows scan` rebuilds them.
export const graphFile = (project: Project, repo: Pick<Repo, 'path' | 'role'>): string =>
  join(projectDataDir(project), 'graphs', `${repo.role}-${encodeURIComponent(repo.path)}.json`);

// An invalid graph is an adapter bug, so it throws the schema error rather than a FlowsError.
export const saveGraph = (project: Project, graph: Graph): void =>
  writeJsonAtomic(graphFile(project, { path: graph.repo, role: graph.role }), GraphSchema.parse(graph));

export const loadGraph = (project: Project, repo: Repo): Graph | undefined => readCache(graphFile(project, repo), GraphSchema);
