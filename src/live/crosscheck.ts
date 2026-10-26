import { shape } from '../engine/describe.ts';
import { resolve } from 'node:path';
import type { Project, Repo } from '../config/project.ts';
import { loadGraph } from '../graph/store.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import type { Evidence } from '../model/evidence.ts';
import type { Flow } from '../model/flow.ts';
import { loadRules, type MatchRule } from '../rules/learned.ts';
import { actionFor, callMatches, formFor, indexOf, overlap, pagePattern, routeFor, type SourceIndex } from './match.ts';
import { observedFlows, resolves, shownControls, skippedActs, type Call, type Seen, type Shown, type Skipped } from './observed.ts';
import { bestMatch, generalize, pageRegex, routeRegex } from './paths.ts';
import { loadRuns, type Run } from './run.ts';

// PLAN.md Phase 3 cross-check: an observed flow is matched to a source flow (UI: its page and its visible elements;
// API: method and path pattern). A matched source flow is confirmed; one that wasn't seen is tagged "not observed",
// or "role not explored" when a guard no run got past stands in front of it; observed flows with no source match
// are observed-only, shown for review.

export { NOT_OBSERVED, ROLE_NOT_EXPLORED } from '../model/tags.ts';

// Statuses that say the route isn't there, so they can't confirm it.
const NOT_THERE = new Set([404, 405, 501]);

// mine: the observed flows this repo is home to; shown: the forms and controls each page state showed; skipped:
// what the runs saw and didn't do, to say why.
// rules: the corrections people made in the inspector (what a live element is), used before any guess.
export type Live = { runs: Run[]; seen: Seen[]; mine: Seen[]; shown: Shown[]; skipped: Skipped[]; rules: MatchRule[] };

// missing: what a match needs and no run saw; notes: what else is worth knowing (a call not seen, an action skipped).
export type FlowMatch = { all: boolean; evidence: Map<string, Evidence[]>; missing: string[]; notes: string[]; used: string[] };

export type Role = { guard: string; node: string; covered: boolean };

const codeNodes = (step: Flow['steps'][number], index: SourceIndex): GraphNode[] =>
  step.evidence.flatMap((item) => (item.type === 'code' ? (index.nodes.node(item.node_id) ?? []) : []));

const isServerAction = (node: GraphNode | undefined) => node?.kind === 'action' && node.attrs.server;

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// What the live app showed of one source flow, step by step.
export function matchFlow(flow: Flow, index: SourceIndex, live: Pick<Live, 'seen' | 'shown' | 'skipped' | 'rules'>): FlowMatch {
  const { seen, shown, skipped, rules } = live;
  const match: FlowMatch = { all: false, evidence: new Map(), missing: [], notes: [], used: [] };
  const { entry, act } = shape(flow, index.nodes);
  if (index.graph.role === 'api') {
    if (entry?.kind !== 'route') return { ...match, missing: ['it does not start at a route'] };
    // A call counts for its most specific route only: GET /users/me is the "me" route, not /users/:id.
    const answered = seen.filter((item) => item.page === undefined && item.calls.length === 1 && routeFor(index, item.calls[0])?.id === entry.id);
    const good = answered.find((item) => !NOT_THERE.has(item.calls[0].status ?? 0));
    match.used = answered.map((item) => item.flow.id);
    const blocked = seen.some((item) => item.page !== undefined && item.calls.some((call) => call.blocked && routeFor(index, call)?.id === entry.id));
    if (good !== undefined) {
      for (const step of flow.steps) if (step.kind === 'api') match.evidence.set(step.id, good.flow.steps[0].evidence);
    } else if (answered.length > 0) match.missing.push(`the live app answered ${answered[0].calls[0].status}`);
    else if (blocked || WRITES.has(entry.attrs.method)) match.missing.push(blocked ? "the UI makes this call, but the explorer is read-only and blocked it, so the answer wasn't seen" : 'no run called it; a write is only seen when a person makes it (the inspector)');
    else match.missing.push('no run called it');
    match.all = good !== undefined;
    return match;
  }

  // UI: the page and its visible elements decide. The calls are evidence when a run saw them, but they don't decide:
  // a page can make them on the server (a Next.js server component), out of the browser's sight.
  if (entry?.kind !== 'page') return { ...match, missing: ['it does not start at a page'] };
  const pattern = entry.attrs.path;
  // The page shown counts as seen however the browser got there; a redirect only says the page asked for wasn't.
  const view = seen.find((item) => item.act === undefined && item.page?.pattern === pattern);
  if (view !== undefined) match.used.push(view.flow.id);

  // The form or click: one the explorer took (with the calls it made), or one a page that renders it showed.
  let acted: Seen | undefined;
  let visible: Evidence | undefined;
  const [first, second] = act;
  if (first !== undefined) {
    const flowCalls = flow.steps.flatMap((step) => (step.request === undefined ? [] : [step.request]));
    const callsFit = (item: Seen) => flowCalls.length === 0 || flowCalls.every((call) => item.calls.some((made) => callMatches(call, made))) || (isServerAction(second ?? first) && item.calls.some((made) => made.serverAction));
    const on = index.rendersOn(first.id);
    const isIt = (pagePattern: string, control: { text: string; fields: readonly string[]; selector: string }, calls: readonly Call[]) => {
      const corrected = rules.find((rule) => rule.page === pagePattern && rule.selector === control.selector);
      if (corrected !== undefined) return corrected.node === first.id;
      return first.kind === 'form' ? formFor(index, pagePattern, control.fields, control.text)?.id === first.id : actionFor(index, pagePattern, { text: control.text, calls })?.id === first.id;
    };
    // Every sighting of this form or click is this flow's, though one of them is enough as evidence.
    const sightings = seen
      .filter((item) => item.act !== undefined && item.page !== undefined && on.has(item.page.pattern) && item.act.kind === (first.kind === 'form' ? 'submit' : 'click') && isIt(item.page.pattern, item.act, item.calls))
      .sort((a, b) => overlap(first.kind === 'form' ? first.attrs.fields : [], b.act?.fields ?? []) - overlap(first.kind === 'form' ? first.attrs.fields : [], a.act?.fields ?? []));
    acted = sightings.find(callsFit) ?? sightings[0];
    match.used.push(...sightings.map((item) => item.flow.id));
    if (acted === undefined) {
      for (const state of shown) {
        if (!on.has(state.pattern)) continue;
        const control = (first.kind === 'form' ? state.forms : state.buttons).find((candidate) => isIt(state.pattern, candidate, []));
        if (control !== undefined) {
          visible = { type: 'dom', ref: `${state.ref} ${control.selector}` };
          break;
        }
      }
      const passed = skipped.find((item) => on.has(item.pattern) && item.kind === (first.kind === 'form' ? 'submit' : 'click') && isIt(item.pattern, item, []));
      if (passed !== undefined) match.notes.push(`the explorer saw it on ${passed.pattern} and didn't ${passed.kind === 'submit' ? 'submit' : 'click'} it: ${passed.reason}`);
    }
  }

  for (const step of flow.steps) {
    if (step.kind === 'subflow') continue; // a Log-in step is what the run's session did
    const [node] = codeNodes(step, index);
    if (step.kind === 'ui' && node?.id === entry.id) {
      if (view === undefined) match.missing.push(`no run saw ${pattern}`);
      else match.evidence.set(step.id, view.flow.steps[0].evidence);
    } else if (step.kind === 'ui') {
      const evidence = acted?.flow.steps[1]?.evidence ?? (visible === undefined ? undefined : [visible]);
      if (evidence === undefined) match.missing.push(`no run showed "${step.claim}"`);
      else match.evidence.set(step.id, evidence);
    } else if (step.request !== undefined) {
      const source = acted ?? (first === undefined ? view : undefined);
      const made: Call | undefined = source?.calls.find((call) => callMatches(step.request as { method: string; path: string }, call));
      // A server action's own calls run on the server; the browser sees the server action request instead.
      const server = made === undefined && isServerAction(second ?? first) ? source?.calls.find((call) => call.serverAction) : undefined;
      const found = made ?? server;
      if (found !== undefined) match.evidence.set(step.id, [{ type: 'network', ref: found.ref }]);
      else if (source !== undefined) match.notes.push(`the browser didn't see ${step.request.method} ${step.request.path}; it may be made on the server, out of the explorer's sight`);
    }
  }
  match.all = match.missing.length === 0 && match.evidence.size > 0;
  return match;
}

// Source guards are the roles (PLAN.md Phase 3). A guard is covered once a run saw a page behind it shown without a
// redirect, or a route behind it answer 2xx.
export function rolesOf(index: SourceIndex, seen: readonly Seen[]): Role[] {
  return index.graph.nodes
    .filter((node) => node.kind === 'guard')
    .map((guard) => {
      const behind = index.nodes.into(guard.id, 'guarded-by');
      const covered = behind.some((node) =>
        node.kind === 'page'
          ? seen.some((item) => item.act === undefined && item.page?.pattern === node.attrs.path)
          : node.kind === 'route' && seen.some((item) => item.page === undefined && callMatches(node.attrs, item.calls[0]) && (item.calls[0].status ?? 0) >= 200 && (item.calls[0].status ?? 0) < 300),
      );
      return { guard: guard.kind === 'guard' ? guard.attrs.name : guard.id, node: guard.id, covered };
    });
}

// The guard a flow's entry sits behind that no run got past, if any.
export function unexploredGuard(flow: Flow, index: SourceIndex, roles: readonly Role[]): Role | undefined {
  const { entry } = shape(flow, index.nodes);
  if (entry === undefined) return undefined;
  const guards = new Set(index.nodes.out(entry.id, 'guarded-by').map((node) => node.id));
  return roles.find((role) => !role.covered && guards.has(role.node));
}

// Which repo of a role an observed flow belongs to: the one whose pages (or routes) matched most of its run.
function homeOf(run: Run, role: Repo['role'], repos: readonly { repo: Repo; index: SourceIndex }[]): Repo | undefined {
  const mine = repos.filter((item) => item.repo.role === role);
  const score = (index: SourceIndex) =>
    role === 'web' ? run.states.filter((state) => pagePattern(index, state.path) !== undefined).length : run.requests.filter((request) => request.kind === 'api' && index.routes.some((route) => route.kind === 'route' && callMatches(route.attrs, request))).length;
  return mine.map((item) => ({ repo: item.repo, score: score(item.index) })).sort((a, b) => b.score - a.score)[0]?.repo;
}

// The live input for one repo's flow engine, from every run the project has; undefined when it has none.
export function liveFor(project: Project, repo: Repo, graphs: readonly { repo: Repo; graph: Graph }[] = loadGraphs(project)): Live | undefined {
  const runs = loadRuns(project);
  if (runs.length === 0) return undefined;
  const indexes = graphs.map(({ repo: owner, graph }) => ({ repo: owner, index: indexOf(graph) }));
  const pages = indexes.filter((item) => item.repo.role === 'web').flatMap((item) => item.index.pages);
  const routes = [
    ...indexes.filter((item) => item.repo.role === 'api').flatMap((item) => item.index.pages),
    ...indexes.flatMap((item) => item.index.graph.nodes.flatMap((node) => (node.kind === 'api-call' && node.attrs.path.startsWith('/') ? [node.attrs.path] : []))),
  ];
  const byId = new Map(runs.map((run) => [run.id, run]));
  const seen = observedFlows(runs, { page: (path) => bestMatch(path, pages, pageRegex) ?? generalize(path), route: (path) => bestMatch(path, routes, routeRegex) ?? generalize(path) }).filter((item) =>
    item.flow.steps.every((step) => step.evidence.every((evidence) => evidence.type === 'code' || resolves(evidence.ref, byId))),
  );
  const home = new Map(runs.map((run) => [run.id, { web: homeOf(run, 'web', indexes), api: homeOf(run, 'api', indexes) }]));
  const mine = seen.filter((item) => {
    const owner = home.get(item.run)?.[item.flow.kind === 'ui' ? 'web' : 'api'];
    return owner !== undefined && owner.path === repo.path && owner.role === repo.role;
  });
  const pageOf = { page: (path: string) => bestMatch(path, pages, pageRegex) ?? generalize(path), route: (path: string) => path };
  return { runs, seen, mine, shown: shownControls(runs, pageOf), skipped: skippedActs(runs, pageOf), rules: matchRules(project) };
}

const loadGraphs = (project: Project) => project.config.repos.flatMap((repo) => {
  const graph = loadGraph(project, repo);
  return graph === undefined ? [] : [{ repo, graph }];
});

// The corrections people made in the inspector, from every web repo's .flows/rules.jsonl.
export const matchRules = (project: Project): MatchRule[] =>
  project.config.repos.filter((repo) => repo.role === 'web').flatMap((repo) => loadRules(resolve(project.root, repo.path)).flatMap((rule) => (rule.type === 'match' ? [rule] : [])));
