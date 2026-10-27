import type { Lookup } from '../graph/lookup.ts';
import type { GraphNode } from '../graph/schema.ts';
import type { Live } from '../live/crosscheck.ts';
import { routeRegex } from '../live/paths.ts';
import type { Flow } from '../model/flow.ts';
import type { Backend } from './backend.ts';
import { LOGIN_CLAIM } from './describe.ts';

type Step = Flow['steps'][number];

// What a test needs to run a flow, added after the flows are built, at every scan, from the graph and the live runs
// (it is read from source, not claimed, so nothing here is verified or kept from an earlier scan):
// - a step's path parameters, with their type, and an example value a live run used;
// - a Log-in step's session: how a request carries it, and where the login response puts the token.

// The parameters of a path in either syntax: /orders/:orderId, /products/[id], /docs/[...slug], /files/*.
const paramsIn = (path: string): string[] =>
  Array.from(path.matchAll(/:(\w+)|\[\[?(?:\.\.\.)?(\w+)\]\]?|\*/g), (match) => match[1] ?? match[2] ?? 'path');

// A page pattern in the API's syntax, so one regex reads values out of both: /products/[id] -> /products/:id.
const asRoute = (path: string) => path.replace(/\[\[?\.\.\.\w+\]\]?/g, '*').replace(/\[(\w+)\]/g, ':$1');

const evidenced = (step: Step, nodes: Lookup): GraphNode[] => step.evidence.flatMap((item) => (item.type === 'code' ? (nodes.node(item.node_id) ?? []) : []));

export function enrich(flows: readonly Flow[], nodes: Lookup, backend: Backend | undefined, live: Live | undefined): Flow[] {
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  // Concrete paths a live run requested or opened, to read example values from.
  const requested = live?.runs.flatMap((run) => run.requests.flatMap((request) => {
    try {
      return [{ method: request.method, path: new URL(request.url).pathname }];
    } catch {
      return [];
    }
  })) ?? [];
  const opened = live?.runs.flatMap((run) => run.states.map((state) => state.path)) ?? [];

  // The route an API step calls: its own (an API flow) or the backend's that answers it (a UI flow).
  const routeOf = (step: Step): { route: GraphNode; graph: Lookup } | undefined => {
    const own = evidenced(step, nodes).find((node) => node.kind === 'route');
    if (own !== undefined) return { route: own, graph: nodes };
    const linked = step.answered_by?.evidence[0];
    const route = linked?.type === 'code' ? backend?.nodes.node(linked.node_id) : undefined;
    return route !== undefined && backend !== undefined ? { route, graph: backend.nodes } : undefined;
  };

  const paramsOf = (step: Step): Step['params'] => {
    const isOpen = step.kind === 'ui' && step.check?.kind === 'ui' && step.claim.startsWith('Open ');
    const path = step.request?.path ?? (isOpen && step.check?.kind === 'ui' ? step.check.page : undefined);
    if (path === undefined) return undefined;
    const names = paramsIn(path);
    if (names.length === 0) return undefined;
    const found = step.kind === 'api' ? routeOf(step) : undefined;
    const numeric = found === undefined ? [] : found.graph.out(found.route.id, 'handled-by').flatMap((handler) => (handler.kind === 'handler' ? (handler.attrs.numeric ?? []) : []));
    const pattern = routeRegex(asRoute(path));
    const seen = (step.kind === 'api' ? requested.filter((request) => request.method === step.request?.method).map((request) => request.path) : opened).find((each) => pattern.test(each));
    const values = seen === undefined ? [] : (pattern.exec(seen)?.slice(1) ?? []);
    return names.map((name, i) => ({ name, type: numeric.includes(name) ? ('number' as const) : ('string' as const), ...(values[i] === undefined ? {} : { example: decodeURIComponent(values[i]) }) }));
  };

  // A Log-in step's session: how its guards read it, and where its login flow's response puts the token.
  const sessionOf = (step: Step): Step['session'] => {
    if (step.kind !== 'subflow' || !step.claim.startsWith(LOGIN_CLAIM)) return undefined;
    const carries = evidenced(step, nodes).flatMap((node) => (node.kind === 'guard' && node.attrs.carries !== undefined ? [node.attrs.carries] : []))[0];
    const login = step.subflow_ref === undefined ? undefined : byId.get(step.subflow_ref);
    const tokens = (login?.steps ?? []).flatMap((each) => {
      const found = each.kind === 'api' ? routeOf(each) : undefined;
      if (found === undefined) return [];
      return found.graph
        .out(found.route.id, 'handled-by')
        .flatMap((handler) => found.graph.out(handler.id, 'responds-with'))
        .flatMap((response) => (response.kind === 'response' && response.attrs.token !== undefined && (response.attrs.status ?? 0) < 300 ? [response.attrs.token] : []));
    });
    const session = { ...carries, ...(tokens[0] === undefined ? {} : { token: tokens[0] }) };
    return Object.keys(session).length === 0 ? undefined : session;
  };

  return flows.map((flow) => ({
    ...flow,
    steps: flow.steps.map((step) => {
      const { params: _, session: __, ...rest } = step;
      const params = paramsOf(step);
      const session = sessionOf(step);
      return { ...rest, ...(params === undefined ? {} : { params }), ...(session === undefined ? {} : { session }) };
    }),
  }));
}
