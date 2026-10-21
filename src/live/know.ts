import { resolve } from 'node:path';
import type { Project, Repo } from '../config/project.ts';
import { label } from '../engine/describe.ts';
import { loadFlows } from '../engine/store.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';
import { addRule, today } from '../rules/learned.ts';
import { LiveError } from '../shared/errors.ts';
import { matchRules } from './crosscheck.ts';
import { actionFor, formFor, indexOf, pagePattern, type SourceIndex } from './match.ts';
import type { Facts } from './overlay.ts';
import { generalize } from './paths.ts';

// What source knows about the element a person points at in the inspector (PLAN.md Phase 3: hovering an element
// shows what the graph knows and lets the user correct it).
export type Known = {
  pattern: string; // the page pattern the element is on
  node: { id: string; label: string; ref: string } | null; // what it is in source, if anything
  corrected: boolean; // a person said so (a match rule), rather than the matcher
  flows: string[]; // the flows that cite that node
  candidates: { id: string; label: string }[]; // what else on this page it could be, to correct it to
};

type Web = { repo: Repo; index: SourceIndex; flows: Flow[] };

export type Knowing = { know(facts: Facts): Known; correct(facts: Facts, node: string | null): void };

export function knowing(project: Project, graphs: readonly { repo: Repo; graph: Graph }[]): Knowing {
  const webs: Web[] = graphs.filter(({ repo }) => repo.role === 'web').map(({ repo, graph }) => ({ repo, index: indexOf(graph), flows: loadFlows(project, repo)?.flows ?? [] }));
  // The web repo that has this page, and the page's pattern there.
  const place = (path: string): { web: Web | undefined; pattern: string } => {
    for (const web of webs) {
      const pattern = pagePattern(web.index, path);
      if (pattern !== undefined) return { web, pattern };
    }
    return { web: webs[0], pattern: generalize(path) };
  };
  const kindOf = (facts: Facts): 'form' | 'page' | 'action' => (facts.fields.length > 0 || facts.inForm ? 'form' : facts.href !== null ? 'page' : 'action');

  return {
    know(facts) {
      const { web, pattern } = place(facts.path);
      if (web === undefined) return { pattern, node: null, corrected: false, flows: [], candidates: [] };
      const rule = matchRules(project).find((candidate) => candidate.page === pattern && candidate.selector === facts.selector);
      const kind = kindOf(facts);
      let node: GraphNode | undefined;
      if (rule !== undefined) node = rule.node === null ? undefined : web.index.nodes.node(rule.node);
      else if (kind === 'form') node = formFor(web.index, pattern, facts.fields, facts.text);
      else if (kind === 'page') node = web.index.pageNode(pagePattern(web.index, new URL(facts.href ?? '/', 'http://x').pathname) ?? '');
      else node = actionFor(web.index, pattern, { text: facts.text, calls: [] });
      const candidates = web.index.graph.nodes
        .filter((candidate) => candidate.kind === kind && (kind === 'page' || web.index.rendersOn(candidate.id).has(pattern)))
        .map((candidate) => ({ id: candidate.id, label: label(candidate) }));
      const flows = node === undefined ? [] : web.flows.filter((flow) => flow.steps.some((step) => step.evidence.some((evidence) => evidence.type === 'code' && evidence.node_id === node.id))).map((flow) => flow.name);
      return { pattern, node: node === undefined ? null : { id: node.id, label: label(node), ref: `${node.file}:${node.line}` }, corrected: rule !== undefined, flows, candidates };
    },
    // Saved in the repo that has the page, so it is reviewed and versioned with the code (PLAN.md §3).
    correct(facts, node) {
      const { web, pattern } = place(facts.path);
      if (web === undefined) throw new LiveError('no web repo is registered, so there is no source to correct the match to');
      if (node !== null && web.index.nodes.node(node) === undefined) throw new LiveError(`${node} is not a node of ${web.repo.path}`);
      addRule(resolve(project.root, web.repo.path), { type: 'match', page: pattern, selector: facts.selector, node, added: today() });
    },
  };
}

// What ticks each step of a guided walk: its page, the form or action it acts with, the call it makes, or (a Log-in
// step) the session the walk starts with.
export type Target = { page: string } | { node: string } | { call: { method: string; path: string } } | { session: true };
export type GuidedStep = { id: string; claim: string; target: Target };

export function guidedSteps(flow: Flow, index: SourceIndex): GuidedStep[] {
  return flow.steps
    .filter((step) => step.enabled)
    .map((step) => {
      if (step.kind === 'subflow') return { id: step.id, claim: step.claim, target: { session: true } as const };
      if (step.request !== undefined) return { id: step.id, claim: step.claim, target: { call: step.request } };
      const cited = step.evidence.flatMap((evidence) => (evidence.type === 'code' ? (index.nodes.node(evidence.node_id) ?? []) : []))[0];
      return { id: step.id, claim: step.claim, target: cited?.kind === 'page' ? { page: cited.attrs.path } : { node: cited?.id ?? '' } };
    });
}
