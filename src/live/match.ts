import { words } from '../engine/describe.ts';
import { reachability } from '../engine/reach.ts';
import { lookup, type Lookup } from '../graph/lookup.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import { bestMatch, pageRegex, routeRegex } from './paths.ts';

// PLAN.md Phase 3 matcher, shared by the cross-check and the inspector: which source node an observed page, form,
// click or call is. Deterministic, and each side only against its own graph: pages, forms and clicks against the UI
// graph, routes against the API graph.

export type SourceIndex = {
  graph: Graph;
  nodes: Lookup;
  pages: string[]; // page patterns (web) or route patterns (api)
  pageNode(pattern: string): GraphNode | undefined;
  rendersOn(nodeId: string): ReadonlySet<string>; // the page patterns whose page leads to this node
  routes: GraphNode[];
};

export function indexOf(graph: Graph): SourceIndex {
  const nodes = lookup(graph);
  const reach = reachability(graph, nodes);
  const pageNodes = graph.nodes.filter((node) => node.kind === 'page');
  const byPattern = new Map(pageNodes.flatMap((node) => (node.kind === 'page' ? [[node.attrs.path, node] as const] : [])));
  const on = new Map<string, Set<string>>();
  for (const [pattern, page] of byPattern) for (const id of reach.from(page.id)) on.set(id, (on.get(id) ?? new Set()).add(pattern));
  const routes = graph.nodes.filter((node) => node.kind === 'route');
  return {
    graph,
    nodes,
    pages: graph.role === 'web' ? [...byPattern.keys()] : routes.flatMap((node) => (node.kind === 'route' ? [node.attrs.path] : [])),
    pageNode: (pattern) => byPattern.get(pattern),
    rendersOn: (id) => on.get(id) ?? new Set(),
    routes,
  };
}

export const pagePattern = (index: SourceIndex, path: string): string | undefined => bestMatch(path, index.pages, pageRegex);

// The source call a request is, by method and path pattern; a full URL or an unreadable path never matches.
export const callMatches = (source: { method: string; path: string }, call: { method: string; path: string }): boolean =>
  (source.method === call.method || source.method === 'ALL') && source.path.startsWith('/') && routeRegex(source.path).test(call.path);

// How alike two sets of field names are: the share of the smaller set the other has too, so a form that shows only
// some of its fields (one tab of a sign-in dialog) still matches. Forms match on the names source records.
export function overlap(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const both = [...left].filter((name) => right.has(name)).length;
  const smaller = Math.min(left.size, right.size);
  return left.size === 0 && right.size === 0 ? 1 : smaller === 0 ? 0 : both / smaller;
}

const MIN_OVERLAP = 0.5;

// Every word the control shows is in the node's name ("Cancel order" and cancelOrder).
const named = (text: string, name: string) => {
  const shown = words(text).split(' ').filter((word) => word !== '');
  const own = words(name).split(' ');
  return shown.length > 0 && shown.every((word) => own.includes(word));
};

// The form rendered on the page whose fields best match, when one clearly does. Forms that tie (two with no fields:
// a logout button and a cancel button) are told apart by the submit button's words against what the form runs.
export function formFor(index: SourceIndex, pattern: string, fields: readonly string[], text = ''): GraphNode | undefined {
  const scored = index.graph.nodes
    .filter((node) => node.kind === 'form' && index.rendersOn(node.id).has(pattern))
    .map((node) => ({ node, score: node.kind === 'form' ? overlap(node.attrs.fields, fields) : 0 }))
    .filter(({ node, score }) => score >= MIN_OVERLAP && (fields.length === 0 || (node.kind === 'form' && node.attrs.fields.some((field) => fields.includes(field)))))
    .sort((a, b) => b.score - a.score);
  const top = scored.filter(({ score }) => score === scored[0]?.score);
  if (top.length === 1) return top[0].node;
  const byWords = top.filter(({ node }) => [node, ...index.nodes.out(node.id, 'submits')].some((own) => named(text, own.kind === 'action' ? own.attrs.name : own.id.split(':').slice(2).join(':'))));
  return byWords.length === 1 ? byWords[0].node : undefined;
}

// The click action on the page: the one that makes the call the click made, else the only one whose name has every
// word the button shows ("Create game" and submitCreateGame).
export function actionFor(index: SourceIndex, pattern: string, act: { text: string; calls: readonly { method: string; path: string }[] }): GraphNode | undefined {
  const actions = index.graph.nodes.filter((node) => node.kind === 'action' && index.rendersOn(node.id).has(pattern));
  const byCall = actions.filter((action) => index.nodes.out(action.id, 'calls').some((call) => call.kind === 'api-call' && act.calls.some((made) => callMatches(call.attrs, made))));
  if (byCall.length === 1) return byCall[0];
  const byWords = actions.filter((action) => action.kind === 'action' && named(act.text, action.attrs.name));
  return byWords.length === 1 ? byWords[0] : undefined;
}

// The API route a call is: the most specific pattern with its method.
export function routeFor(index: SourceIndex, call: { method: string; path: string }): GraphNode | undefined {
  const matching = index.routes.filter((route) => route.kind === 'route' && callMatches(route.attrs, call));
  const best = bestMatch(
    call.path,
    matching.flatMap((route) => (route.kind === 'route' ? [route.attrs.path] : [])),
    routeRegex,
  );
  return matching.find((route) => route.kind === 'route' && route.attrs.path === best);
}
