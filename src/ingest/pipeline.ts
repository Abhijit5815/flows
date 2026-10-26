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
import { extractGeneric } from '../rules/generic.ts';
import { loadRules, type GenericRule, type LearnedRule } from '../rules/learned.ts';
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
  excluded: z.array(z.string()), // node ids left out by exclusion rules, with what only they led to
});

export type Coverage = z.infer<typeof CoverageSchema>;

export type ScanResult = { repo: Repo; stack: Stack; graph: Graph | undefined; coverage: Coverage; ms: number };

export type ScanOptions = {
  adapters?: readonly FrameworkAdapter[];
  embedder?: EmbeddingProvider;
  possiblyMissed?: PossiblyMissedOptions;
  extraRules?: readonly LearnedRule[]; // tried on top of the repo's own rules (rule proposals), never saved
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
  const coverage: Coverage = { files: files.length, sources: sources.size, parsed: [], parseErrors: [], unrecognised: [], missed: [], embeddingSearch: false, excluded: [] };
  // What the user taught Flows about this repo (<repo>/.flows/rules.jsonl).
  const learned = [...loadRules(dir), ...(options.extraRules ?? [])];
  const produces = repo.role === 'api' ? 'route' : 'page';
  const generic = learned.filter((rule): rule is GenericRule => rule.type === 'generic' && rule.produces === produces);
  if (stack.framework === undefined && generic.length === 0) return { repo, stack, graph: undefined, coverage, ms: performance.now() - started };

  // Without an adapter, the generic rules drafted from the user's examples are the whole extraction.
  const adapter = stack.framework === undefined ? undefined : adapterFor(stack.framework, repo.role, adapters);
  const ownRules = adapter === undefined ? [] : [...adapter.rules, ...learned.flatMap((rule) => (rule.type === 'pattern' && rule.scope === adapter.id ? [rule.rule] : []))];
  const genericRules = generic.map((rule, i) => ({ ...rule.rule, id: `generic:${i}` }));
  const rules = [...ownRules, ...(adapter?.suspects ?? []), FUNCTION_RULE, ...genericRules];
  const version = sha256(JSON.stringify({ adapter: adapter?.id, rules }));
  const sourceFiles = [...sources].map(([path, source]) => ({ path, source }));
  const { facts, computed } = cachedFacts(repoFile(project, 'facts', repo), version, FileFactsSchema, sourceFiles, (file) => matchRules(rules, file));
  coverage.parsed = computed;
  coverage.parseErrors = [...facts].flatMap(([file, { parseErrors }]) => (parseErrors > 0 ? [{ file, errors: parseErrors }] : []));

  // The adapter sees only its own rules' matches, so files with nothing for it are never loaded into ts-morph.
  const own = new Set(ownRules.map((rule) => rule.id));
  const matched = new Map(
    [...facts].flatMap(([file, found]) => {
      const mine = found.facts.filter((fact) => own.has(fact.rule));
      return mine.length > 0 ? [[file, { ...found, facts: mine }] as const] : [];
    }),
  );
  const builder = new GraphBuilder();
  const guards = learned.flatMap((rule) => (rule.type === 'guard' && rule.scope === adapter?.id ? [rule.name] : []));
  if (adapter !== undefined) coverage.unrecognised = adapter.extract({ files, facts: matched, read, resolver: new Resolver(dir, sources), graph: builder, guards });
  const genericFiles = new Set([...facts].flatMap(([file, found]) => (found.facts.some((fact) => fact.rule.startsWith('generic:')) ? [file] : [])));
  coverage.unrecognised.push(...extractGeneric(generic, sources, builder, genericFiles));
  const built = builder.build(repo.role, repo.path, adapter?.id ?? 'learned');
  // "Not a flow": excluded nodes leave the graph, and so does whatever only they led to (a route's own handler and
  // its responses). Nodes nothing pointed at to begin with, such as Prisma models, stay.
  const excluded = new Set(learned.flatMap((rule) => (rule.type === 'exclude' ? [rule.node] : [])));
  const removed = new Set(built.nodes.filter((node) => excluded.has(node.id)).map((node) => node.id));
  for (let before = -1; before !== removed.size; ) {
    before = removed.size;
    for (const node of built.nodes) {
      const incoming = built.edges.filter((edge) => edge.to === node.id);
      if (incoming.length > 0 && incoming.every((edge) => removed.has(edge.from))) removed.add(node.id);
    }
  }
  const graph = { ...built, nodes: built.nodes.filter((node) => !removed.has(node.id)), edges: built.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)) } as Graph;
  coverage.excluded = [...removed];
  saveGraph(project, graph);

  const embedding = options.embedder && { provider: options.embedder, cacheFile: repoFile(project, 'vectors', repo), options: options.possiblyMissed ?? DEFAULT_POSSIBLY_MISSED };
  coverage.missed = await possiblyMissed(graph, facts, sources, adapter?.suspects ?? [], embedding);
  coverage.embeddingSearch = embedding !== undefined;
  writeJsonAtomic(repoFile(project, 'coverage', repo), coverage);
  return { repo, stack, graph, coverage, ms: performance.now() - started };
}
