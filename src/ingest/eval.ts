import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroundTruthSchema, type GroundTruth } from './keys.ts';
import { addRepo, initProject } from '../config/project.ts';
import type { Graph } from '../graph/schema.ts';
import { ConfigError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';
import { scanRepo, type Coverage } from './pipeline.ts';

// PLAN.md Phase 2 exit: what the scan extracts, compared with a hand-written answer key. Pages are compared by path,
// endpoints by method and path; every miss and every extra is listed.
export type Score = { expected: number; found: number; matched: number; recall: number; precision: number; missed: string[]; extra: string[] };

export function score(expected: readonly string[], found: readonly string[]): Score {
  const want = new Set(expected);
  const got = new Set(found);
  const matched = [...got].filter((key) => want.has(key)).length;
  return {
    expected: want.size,
    found: got.size,
    matched,
    recall: want.size === 0 ? 1 : matched / want.size,
    precision: got.size === 0 ? 1 : matched / got.size,
    missed: [...want].filter((key) => !got.has(key)).sort(),
    extra: [...got].filter((key) => !want.has(key)).sort(),
  };
}

const endpointsOf = (graph: Graph | undefined) => (graph?.nodes ?? []).flatMap((node) => (node.kind === 'route' ? [`${node.attrs.method} ${node.attrs.path}`] : []));
const pagesOf = (graph: Graph | undefined) => (graph?.nodes ?? []).flatMap((node) => (node.kind === 'page' ? [node.attrs.path] : []));

export type AppScore = { app: string; endpoints: Score | undefined; pages: Score | undefined; coverage: Record<string, Coverage>; ms: number };

export function loadKeys(dir: string): GroundTruth[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch (error) {
        throw new ConfigError(`${join(dir, file)} is not valid JSON`, { cause: error });
      }
      return parseOrThrow(GroundTruthSchema, raw, join(dir, file), ConfigError);
    });
}

// Scans one sample app's role folders in a throwaway project and scores them against its key.
export async function evaluate(key: GroundTruth, appDir: string): Promise<AppScore> {
  const started = performance.now();
  const scratch = mkdtempSync(join(tmpdir(), 'flows-eval-'));
  try {
    let project = initProject(scratch, key.app, 'store');
    for (const [role, folder] of Object.entries(key.roles)) project = addRepo(project, join(appDir, folder), role);
    const graphs: Record<string, Graph | undefined> = {};
    const coverage: Record<string, Coverage> = {};
    for (const repo of project.config.repos) {
      const result = await scanRepo(project, repo);
      graphs[repo.role] = result.graph;
      coverage[repo.role] = result.coverage;
    }
    return {
      app: key.app,
      endpoints: key.roles.api === undefined ? undefined : score(key.endpoints.map((e) => `${e.method} ${e.path}`), endpointsOf(graphs.api)),
      pages: key.roles.web === undefined ? undefined : score(key.pages.map((p) => p.path), pagesOf(graphs.web)),
      coverage,
      ms: performance.now() - started,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
