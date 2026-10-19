import { join } from 'node:path';
import { projectDataDir, type Project, type Repo } from '../config/project.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';
import { GraphSchema, type Graph } from './schema.ts';

// Per-repo files in the deletable cache (graphs, parse facts, coverage), one per registered repo and role.
export const repoFile = (project: Project, folder: string, repo: Pick<Repo, 'path' | 'role'>): string =>
  join(projectDataDir(project), folder, `${repo.role}-${encodeURIComponent(repo.path)}.json`);

// `flows scan` rebuilds graphs; nothing else writes them.
export const graphFile = (project: Project, repo: Pick<Repo, 'path' | 'role'>): string => repoFile(project, 'graphs', repo);

// An invalid graph is an adapter bug, so it throws the schema error rather than a FlowsError.
export const saveGraph = (project: Project, graph: Graph): void =>
  writeJsonAtomic(graphFile(project, { path: graph.repo, role: graph.role }), GraphSchema.parse(graph));

export const loadGraph = (project: Project, repo: Repo): Graph | undefined => readCache(graphFile(project, repo), GraphSchema);
