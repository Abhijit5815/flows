import { lookup, type Lookup } from '../graph/lookup.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import { FALLBACK_CATEGORY_ID } from '../model/category.ts';
import { HTTP_METHODS, type Flow } from '../model/flow.ts';
import { FlowsError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { claimOf, evidenceOf, flowName, label } from './describe.ts';

type Step = Flow['steps'][number];
export type DraftStep = Omit<Step, 'id'>;

// A candidate the engine did not build, and why; listed with the rejected flows (PLAN.md Phase 4).
export type Skipped = { node: string; name: string; reason: string; flow?: Flow }; // flow: what a person can promote
export type Candidates = { flows: Flow[]; skipped: Skipped[]; notes: Record<string, string[]> };

// Ids come from the nodes a flow is built around, so they stay the same from scan to scan.
export const flowId = (kind: Flow['kind'], key: string): string => `${kind}-${sha256(key).slice(0, 8)}`;

export const numbered = (steps: readonly DraftStep[]): Step[] => steps.map((step, i) => ({ ...step, id: `s${i + 1}` }));

export function template(kind: Step['kind'], nodes: readonly GraphNode[]): string {
  const claim = claimOf(kind, nodes);
  if (claim === undefined) throw new FlowsError(`no claim template for a ${kind} step citing ${nodes.map((node) => node.id).join(', ')}`); // a bug here, not bad input
  return claim;
}

const isOk = (status: number | undefined) => status !== undefined && status >= 200 && status < 300;

export function draft(kind: Flow['kind'], key: string, steps: DraftStep[], graph: Lookup): Flow {
  const all = numbered(steps);
  return {
    schema_version: 0,
    id: flowId(kind, key),
    name: flowName({ steps: all }, graph) ?? key,
    category: FALLBACK_CATEGORY_ID, // classify, verify and the judge fill in the rest
    kind,
    origin: 'source',
    status: 'unverified',
    confidence: 0,
    enabled: false,
    destructive: 'unknown',
    priority: 'medium',
    tags: [],
    version: 1,
    steps: all,
  };
}

// The steps the engine writes, shared by generated flows and by the flows a person draws or describes.
export const openStep = (page: GraphNode): DraftStep => ({ kind: 'ui', claim: template('ui', [page]), evidence: [evidenceOf(page)], check: { kind: 'ui', page: label(page), evidence: [evidenceOf(page)] }, enabled: true });

// A form or click that runs an action: where the action redirects is the check (when it names one place), and the
// messages it returns are the errors.
export const uiStep = (cited: GraphNode[]): DraftStep => {
  const action = cited.find((node) => node.kind === 'action');
  const outcomes = action?.kind === 'action' ? action.attrs : undefined;
  const redirects = outcomes?.redirects ?? [];
  return {
    kind: 'ui',
    claim: template('ui', cited),
    evidence: cited.map(evidenceOf),
    check: action !== undefined && redirects.length === 1 ? { kind: 'ui', page: redirects[0], evidence: [evidenceOf(action)] } : null,
    ...(action !== undefined && outcomes?.messages !== undefined ? { errors: outcomes.messages.map((message) => ({ kind: 'ui' as const, message, evidence: [evidenceOf(action)] })) } : {}),
    enabled: true,
  };
};

// Who sends an error, by name; a handler written inline is named after its route, so it is "the handler".
export const errorSource = (owner: GraphNode, route: GraphNode): string => (owner.kind === 'handler' && label(owner) === label(route) ? 'the handler' : label(owner));

// What a route answers besides success: its guards' and middleware's error responses, then its handler's; one error
// per message, so "missing token" and "invalid token" are two cases.
export function routeErrors(route: GraphNode, nodes: Lookup): NonNullable<Step['errors']> {
  const owners = [...nodes.out(route.id, 'guarded-by'), ...nodes.out(route.id, 'uses'), ...nodes.out(route.id, 'handled-by')];
  return owners.flatMap((owner) =>
    nodes.out(owner.id, 'responds-with').flatMap((response) => {
      if (response.kind !== 'response' || response.attrs.status === undefined || response.attrs.status < 400) return [];
      const error = { kind: 'api' as const, status: response.attrs.status, by: errorSource(owner, route), evidence: [evidenceOf(response)] };
      return response.attrs.messages === undefined ? [error] : response.attrs.messages.map((message) => ({ ...error, message }));
    }),
  );
}

// The body a route validates, with its fields; only for methods that send one.
export function routeBody(route: GraphNode, nodes: Lookup): NonNullable<Step['request']>['body'] {
  if (route.kind !== 'route' || ['GET', 'HEAD', 'OPTIONS'].includes(route.attrs.method)) return undefined;
  const schema = nodes.out(route.id, 'validated-by').find((node) => node.kind === 'request-schema' && node.attrs.fields !== undefined);
  return schema?.kind === 'request-schema' && schema.attrs.fields !== undefined ? { schema: schema.attrs.name, fields: schema.attrs.fields, evidence: [evidenceOf(schema)] } : undefined;
}

// shortcut: a full URL means another service and "?" an unreadable path; neither can be a request, so the step is
// left out (the caller notes why), never guessed.
export function callStep(call: GraphNode): DraftStep | string {
  if (call.kind !== 'api-call') return `${call.id} is not an API call`;
  const { method, path } = call.attrs;
  if (method === 'ALL' || !path.startsWith('/') || !(HTTP_METHODS as readonly string[]).includes(method)) {
    return `${label(call)} at ${call.file}:${call.line} is left out: ${path.startsWith('http') ? 'it calls another service' : 'its path could not be read'}`;
  }
  return { kind: 'api', claim: template('api', [call]), request: { method: method as (typeof HTTP_METHODS)[number], path }, evidence: [evidenceOf(call)], check: null, enabled: true };
}

// Call the route and expect its only success response; a route that answers every method has no single request.
export function routeStep(route: GraphNode, nodes: Lookup): DraftStep | string {
  if (route.kind !== 'route') return `${route.id} is not a route`;
  const { method, path } = route.attrs;
  if (method === 'ALL') return 'ALL answers every method, so there is no single request to make';
  const handler = nodes.out(route.id, 'handled-by')[0];
  const ok = (handler === undefined ? [] : nodes.out(handler.id, 'responds-with')).filter((node) => node.kind === 'response' && isOk(node.attrs.status));
  const response = ok.length === 1 && ok[0].kind === 'response' ? ok[0] : undefined;
  const check: Step['check'] =
    response === undefined || response.attrs.status === undefined
      ? null
      : { kind: 'api', status: response.attrs.status, ...(response.attrs.fields.length > 0 ? { fields: response.attrs.fields } : {}), evidence: [evidenceOf(response)] };
  const cited = handler === undefined ? [route] : [route, handler];
  const body = routeBody(route, nodes);
  const errors = routeErrors(route, nodes);
  return {
    kind: 'api',
    claim: template('api', cited),
    request: { method, path, ...(body === undefined ? {} : { body }) },
    evidence: cited.map(evidenceOf),
    check,
    ...(errors.length > 0 ? { errors } : {}),
    enabled: true,
  };
}

// One flow per route: call it, and expect its only success response.
function apiCandidates(graph: Graph, nodes: Lookup): Candidates {
  const found: Candidates = { flows: [], skipped: [], notes: {} };
  for (const route of graph.nodes) {
    if (route.kind !== 'route') continue;
    if (route.attrs.method === 'OPTIONS') {
      found.skipped.push({ node: route.id, name: label(route), reason: 'an OPTIONS route answers CORS preflight requests from browsers; no user does it' });
      continue;
    }
    const step = routeStep(route, nodes);
    if (typeof step === 'string') found.skipped.push({ node: route.id, name: label(route), reason: step });
    else found.flows.push(draft('api', route.id, [step], nodes));
  }
  return found;
}

// Breadth-first along one edge kind, the start nodes included.
export function along(start: readonly GraphNode[], kind: string, nodes: Lookup): GraphNode[] {
  const seen = new Map<string, GraphNode>();
  for (const queue = [...start]; queue.length > 0; ) {
    const node = queue.shift() as GraphNode; // safe: the queue is not empty
    if (seen.has(node.id)) continue;
    seen.set(node.id, node);
    queue.push(...nodes.out(node.id, kind));
  }
  return [...seen.values()];
}

// UI flows start at pages (the file router makes every page an entry point): a view flow per page, then one flow per
// form and per click that does something source can see, each built once from the shortest page that reaches it.
function webCandidates(graph: Graph, nodes: Lookup): Candidates {
  const found: Candidates = { flows: [], skipped: [], notes: {} };
  const pages = graph.nodes.filter((node) => node.kind === 'page').sort((a, b) => label(a).length - label(b).length || label(a).localeCompare(label(b)));

  const add = (key: string, steps: DraftStep[], calls: readonly GraphNode[]) => {
    const notes: string[] = [];
    for (const call of calls) {
      const step = callStep(call);
      if (typeof step === 'string') notes.push(step);
      else steps.push(step);
    }
    const flow = draft('ui', key, steps, nodes);
    found.flows.push(flow);
    if (notes.length > 0) found.notes[flow.id] = notes;
  };
  const open = openStep;
  const ui = uiStep;

  for (const page of pages) {
    const loads = [...new Map(along([page], 'renders', nodes).flatMap((owner) => nodes.out(owner.id, 'calls')).map((call) => [call.id, call])).values()];
    add(page.id, [open(page)], loads);
  }

  const built = new Set<string>();
  for (const page of pages) {
    for (const owner of along([page, ...nodes.out(page.id, 'wrapped-by')], 'renders', nodes)) {
      for (const form of nodes.out(owner.id, 'contains')) {
        if (built.has(form.id)) continue;
        built.add(form.id);
        const actions = nodes.out(form.id, 'submits');
        for (const action of actions.length > 0 ? actions : [undefined]) {
          const calls = action === undefined ? [] : nodes.out(action.id, 'calls');
          // One flow per call: steps are ordered, and the graph doesn't say which call a branch makes.
          for (const call of calls.length > 0 ? calls : [undefined]) {
            add([form.id, action?.id, call?.id].filter((id) => id !== undefined).join('|'), [open(page), ui(action === undefined ? [form] : [form, action])], call === undefined ? [] : [call]);
          }
        }
      }
      for (const action of nodes.out(owner.id, 'triggers')) {
        if (built.has(action.id)) continue;
        built.add(action.id);
        const calls = nodes.out(action.id, 'calls');
        // A click that calls nothing and runs no server action does nothing source can see, unless a library call it
        // makes reaches the server itself (next-auth's signOut).
        if (calls.length === 0 && !(action.kind === 'action' && (action.attrs.server || action.attrs.library !== undefined))) {
          const flow = draft('ui', action.id, [open(page), ui([action, owner])], nodes);
          found.skipped.push({ node: action.id, name: flow.name, reason: "it makes no API call and runs no server action, so source doesn't show what it does", flow });
          continue;
        }
        for (const call of calls.length > 0 ? calls : [undefined]) {
          add([action.id, call?.id].filter((id) => id !== undefined).join('|'), [open(page), ui([action, owner])], call === undefined ? [] : [call]);
        }
      }
    }
  }
  return found;
}

// PLAN.md Phase 4: candidates by graph traversal from real entry points, no LLM.
export function candidates(graph: Graph): Candidates {
  const nodes = lookup(graph);
  return graph.role === 'api' ? apiCandidates(graph, nodes) : webCandidates(graph, nodes);
}
