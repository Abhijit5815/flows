import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { FrameworkAdapter } from '../adapters/adapter.ts';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import type { Project, Repo } from '../config/project.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { GraphBuilder } from '../graph/builder.ts';
import type { Graph } from '../graph/schema.ts';
import { repoFile, saveGraph } from '../graph/store.ts';
import { sha256 } from '../shared/hash.ts';
import { writeJsonAtomic } from '../shared/json-file.ts';
import { cachedFacts } from './cache.ts';
import { stackOf, type Stack } from './detect.ts';
import { listFiles } from './files.ts';
import { FileFactsSchema, isSource, matchRules } from './match.ts';
import { FUNCTION_RULE, possiblyMissed, type PossiblyMissedOptions } from './missed.ts';
import { Resolver } from './resolve.ts';

// PLAN.md Phase 2 coverage report: what was listed, parsed and recognised in one scan, and what may have been missed.
// Saved with the graph and read back by `flows show missed`, so it has a schema like every file Flows reads.
const PlaceSchema = z.object({ file: z.string(), line: z.int().min(1), reason: z.string() });
export const CoverageSchema = z.object({
  files: z.int().min(0), // every file in the repo folder
  sources: z.int().min(0), // source files the rules ran on; the rest were skipped
  parsed: z.array(z.string()), // source files parsed this time; the rest came from the cache
  parseErrors: z.array(z.object({ file: z.string(), errors: z.int().min(1) })),
  unrecognised: z.array(PlaceSchema),
  missed: z.array(PlaceSchema.extend({ similarity: z.number().optional() })),
  embeddingSearch: z.boolean(), // false when no embedding model was given; the pattern search still ran
});

export type Coverage = z.infer<typeof CoverageSchema>;

export type ScanResult = { repo: Repo; stack: Stack; graph: Graph | undefined; coverage: Coverage; ms: number };

export type ScanOptions = {
  adapters?: readonly FrameworkAdapter[];
  embedder?: EmbeddingProvider;
  possiblyMissed?: PossiblyMissedOptions;
};

// 0.78 for bge-small: the planted missed handler scores 0.80, and supporting code that nothing calls stays below
// on the samples (Phase 2 measurements).
export const DEFAULT_POSSIBLY_MISSED: PossiblyMissedOptions = { minSimilarity: 0.78, limit: 20 };

// Lists, parses (cached per file) and extracts one repo's graph, then saves it with its coverage report.
// Reads files only; never runs them.
export async function scanRepo(project: Project, repo: Repo, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const adapters = options.adapters ?? ADAPTERS;
  const dir = resolve(project.root, repo.path);
  const stack = stackOf(project.root, repo, adapters);
  const files = listFiles(dir);
  const read = (path: string): string => readFileSync(join(dir, path), 'utf8');
  const sources = new Map(files.filter(isSource).map((path) => [path, read(path)]));
  const coverage: Coverage = { files: files.length, sources: sources.size, parsed: [], parseErrors: [], unrecognised: [], missed: [], embeddingSearch: false };
  if (stack.framework === undefined) return { repo, stack, graph: undefined, coverage, ms: performance.now() - started };

  const adapter = adapterFor(stack.framework, repo.role, adapters);
  const rules = [...adapter.rules, ...adapter.suspects, FUNCTION_RULE];
  const version = sha256(JSON.stringify({ adapter: adapter.id, rules }));
  const sourceFiles = [...sources].map(([path, source]) => ({ path, source }));
  const { facts, computed } = cachedFacts(repoFile(project, 'facts', repo), version, FileFactsSchema, sourceFiles, (file) => matchRules(rules, file));
  coverage.parsed = computed;
  coverage.parseErrors = [...facts].flatMap(([file, { parseErrors }]) => (parseErrors > 0 ? [{ file, errors: parseErrors }] : []));

  // The adapter sees only its own rules' matches, so files with nothing for it are never loaded into ts-morph.
  const own = new Set(adapter.rules.map((rule) => rule.id));
  const matched = new Map(
    [...facts].flatMap(([file, found]) => {
      const mine = found.facts.filter((fact) => own.has(fact.rule));
      return mine.length > 0 ? [[file, { ...found, facts: mine }] as const] : [];
    }),
  );
  const builder = new GraphBuilder();
  coverage.unrecognised = adapter.extract({ files, facts: matched, read, resolver: new Resolver(dir, sources), graph: builder });
  const graph = builder.build(repo.role, repo.path, adapter.id);
  saveGraph(project, graph);

  const embedding = options.embedder && { provider: options.embedder, cacheFile: repoFile(project, 'vectors', repo), options: options.possiblyMissed ?? DEFAULT_POSSIBLY_MISSED };
  coverage.missed = await possiblyMissed(graph, facts, sources, adapter.suspects, embedding);
  coverage.embeddingSearch = embedding !== undefined;
  writeJsonAtomic(repoFile(project, 'coverage', repo), coverage);
  return { repo, stack, graph, coverage, ms: performance.now() - started };
}
