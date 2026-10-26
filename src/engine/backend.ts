import { lookup, type Lookup } from '../graph/lookup.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import { callMatches } from '../live/match.ts';
import type { Flow } from '../model/flow.ts';
import { flowId, routeStep } from './candidates.ts';
import { evidenceOf } from './describe.ts';

// The project's API graphs as one, so a UI flow's calls can be followed to the routes that answer them.
// shortcut: two API repos with the same route share its node id here and the first wins; key by repo if that happens.
export type Backend = { nodes: Lookup; routes: GraphNode[] };

export function backendOf(graphs: readonly Graph[]): Backend | undefined {
  if (graphs.length === 0) return undefined;
  const merged = { nodes: graphs.flatMap((graph): GraphNode[] => graph.nodes), edges: graphs.flatMap((graph): { from: string; to: string; kind: string }[] => graph.edges) };
  return { nodes: lookup(merged), routes: merged.nodes.filter((node) => node.kind === 'route' && node.attrs.method !== 'ALL') };
}

// The route that answers a call: the same method, a path pattern that matches, and the most specific one when several
// do (/users/me over /users/:id). An ALL route answers every method, so it is never the single answer.
export function routeFor(request: { method: string; path: string }, backend: Backend): GraphNode | undefined {
  const params = (node: GraphNode) => (node.kind === 'route' ? (node.attrs.path.match(/:/g) ?? []).length : 0);
  return backend.routes.filter((route) => route.kind === 'route' && callMatches(route.attrs, request)).sort((a, b) => params(a) - params(b))[0];
}

// A UI flow's API steps, each linked to the route that answers it and given that route's check, errors and body.
export function linkCalls(flow: Flow, backend: Backend): Flow {
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      if (step.kind !== 'api' || step.request === undefined) return step;
      const { answered_by: _, ...unlinked } = step;
      const route = routeFor(step.request, backend);
      const answer = route === undefined ? undefined : routeStep(route, backend.nodes);
      if (route === undefined || answer === undefined || typeof answer === 'string') return unlinked;
      const body = answer.request?.body;
      return {
        ...unlinked,
        request: { method: step.request.method, path: step.request.path, ...(body === undefined ? {} : { body }) },
        check: answer.check,
        ...(answer.errors === undefined ? {} : { errors: answer.errors }),
        answered_by: { flow: flowId('api', route.id), evidence: [evidenceOf(route)] },
      };
    }),
  };
}
