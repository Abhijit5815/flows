import { parse } from '@ast-grep/napi';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FrameworkAdapter } from '../adapters/adapter.ts';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import type { Project, Repo } from '../config/project.ts';
import type { GraphNode } from '../graph/schema.ts';
import { stackOf } from '../ingest/detect.ts';
import { languageOf } from '../ingest/match.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { FlowsError } from '../shared/errors.ts';
import { today, type LearnedRule } from './learned.ts';

export type Place = { file: string; line: number };
export type Proposal = { rule: LearnedRule; finds: string[] };

// Patterns for the calls that start on the pointed line, outermost call first, each from general to narrow:
// a computed-method call keeps only its shape; a method call keeps its receiver ("app.$M"), then only its shape.
function candidatePatterns(dir: string, { file, line }: Place): string[] {
  const language = languageOf(file);
  if (language === undefined) return [];
  const calls = parse(language, readFileSync(join(dir, file), 'utf8'))
    .root()
    .findAll({ rule: { kind: 'call_expression' } })
    .filter((call) => call.range().start.line + 1 === line)
    .sort((a, b) => b.text().length - a.text().length);
  return [...new Set(calls.flatMap((call) => {
    const callee = call.field('function');
    const object = callee?.field('object')?.text();
    if (callee?.kind() === 'subscript_expression') return ['$R[$M]($$$ARGS)', `${object}[$M]($$$ARGS)`];
    if (callee?.kind() === 'member_expression') return [`${object}.$M($$$ARGS)`, '$R.$M($$$ARGS)'];
    return callee?.kind() === 'identifier' ? [`${callee.text()}($$$ARGS)`] : [];
  }))];
}

// "You missed this": the rule that makes the scan find something at the place the user points at. Every candidate
// is checked by scanning with it into a throwaway cache, so a proposal always reproduces the pointed line, and
// `finds` lists everything new it would add, for the user to see before saving it.
export async function proposeRule(project: Project, repo: Repo, place: Place, adapters: readonly FrameworkAdapter[] = ADAPTERS): Promise<Proposal> {
  const example = `${place.file}:${place.line}`;
  const scope = stackOf(project.root, repo, adapters).framework;
  if (scope === undefined) throw new FlowsError(`no adapter reads ${repo.path}; draft a rule from examples instead: flows rule draft --example <path:line>`);
  const scratch = mkdtempSync(join(tmpdir(), 'flows-propose-'));
  const trial: Project = { ...project, config: { ...project.config, storage_dir: scratch } };
  const scan = async (extraRules: LearnedRule[]): Promise<GraphNode[]> => (await scanRepo(trial, repo, { adapters, extraRules })).graph?.nodes ?? [];
  const at = (nodes: GraphNode[]) => nodes.filter((node) => node.file === place.file && node.line === place.line);
  try {
    const baseline = await scan([]);
    const here = at(baseline);
    // Pointing at a middleware means "this is an auth guard" (PLAN.md §14 expects one such correction).
    const middleware = here.find((node) => node.kind === 'middleware');
    if (middleware?.kind === 'middleware') {
      const rule: LearnedRule = { type: 'guard', scope, name: middleware.attrs.name, example, added: today() };
      return { rule, finds: at(await scan([rule])).filter((node) => node.kind === 'guard').map((node) => node.id) };
    }
    if (here.length > 0) throw new FlowsError(`${example} is already in the graph: ${here.map((node) => node.id).join(', ')}`);
    const known = new Set(baseline.map((node) => node.id));
    const ids = [...new Set(adapterFor(scope, repo.role, adapters).rules.map((rule) => rule.id))];
    for (const pattern of candidatePatterns(resolve(project.root, repo.path), place)) {
      for (const id of ids) {
        const rule: LearnedRule = { type: 'pattern', scope, rule: { id, rule: { pattern } }, example, added: today() };
        let nodes: GraphNode[];
        try {
          nodes = await scan([rule]);
        } catch {
          continue; // ast-grep could not use the pattern
        }
        const finds = nodes.filter((node) => !known.has(node.id));
        if (at(finds).length > 0) return { rule, finds: finds.map((node) => node.id) };
      }
    }
    throw new FlowsError(`no rule Flows can build finds anything at ${example}; it stays in the possibly-missed list`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
