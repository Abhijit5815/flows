import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FrameworkAdapter, Unrecognised } from '../adapters/adapter.ts';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import type { Project, Repo } from '../config/project.ts';
import { GraphBuilder } from '../graph/builder.ts';
import type { Graph } from '../graph/schema.ts';
import { repoFile, saveGraph } from '../graph/store.ts';
import { sha256 } from '../shared/hash.ts';
import { cachedFacts } from './cache.ts';
import { stackOf, type Stack } from './detect.ts';
import { listFiles } from './files.ts';
import { FileFactsSchema, isSource, matchRules } from './match.ts';
import { Resolver } from './resolve.ts';

// PLAN.md Phase 2 coverage report: what was listed, parsed and recognised in one scan.
export type Coverage = {
  files: number; // every file in the repo folder
  sources: number; // source files the rules ran on; the rest were skipped
  parsed: string[]; // source files parsed this time; the rest came from the cache
  parseErrors: { file: string; errors: number }[];
  unrecognised: Unrecognised[];
};

export type ScanResult = { repo: Repo; stack: Stack; graph: Graph | undefined; coverage: Coverage; ms: number };

export type ScanOptions = { adapters?: readonly FrameworkAdapter[] };

// Lists, parses (cached per file) and extracts one repo's graph, then saves it. Reads files only; never runs them.
export async function scanRepo(project: Project, repo: Repo, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const adapters = options.adapters ?? ADAPTERS;
  const dir = resolve(project.root, repo.path);
  const stack = stackOf(project.root, repo, adapters);
  const files = listFiles(dir);
  const read = (path: string): string => readFileSync(join(dir, path), 'utf8');
  const sources = new Map(files.filter(isSource).map((path) => [path, read(path)]));
  const coverage: Coverage = { files: files.length, sources: sources.size, parsed: [], parseErrors: [], unrecognised: [] };
  if (stack.framework === undefined) return { repo, stack, graph: undefined, coverage, ms: performance.now() - started };

  const adapter = adapterFor(stack.framework, repo.role, adapters);
  const version = sha256(JSON.stringify({ adapter: adapter.id, rules: adapter.rules }));
  const sourceFiles = [...sources].map(([path, source]) => ({ path, source }));
  const { facts, computed } = cachedFacts(repoFile(project, 'facts', repo), version, FileFactsSchema, sourceFiles, (file) => matchRules(adapter.rules, file));
  coverage.parsed = computed;
  coverage.parseErrors = [...facts].flatMap(([file, { parseErrors }]) => (parseErrors > 0 ? [{ file, errors: parseErrors }] : []));

  // Files with no match are never loaded into ts-morph.
  const matched = new Map([...facts].filter(([, found]) => found.facts.length > 0));
  const builder = new GraphBuilder();
  coverage.unrecognised = adapter.extract({ files, facts: matched, read, resolver: new Resolver(dir, sources), graph: builder });
  const graph = builder.build(repo.role, repo.path, adapter.id);
  saveGraph(project, graph);
  return { repo, stack, graph, coverage, ms: performance.now() - started };
}
