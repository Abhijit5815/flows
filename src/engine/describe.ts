import type { Lookup } from '../graph/lookup.ts';
import type { GraphNode } from '../graph/schema.ts';
import type { Evidence } from '../model/evidence.ts';
import type { Flow } from '../model/flow.ts';

// Every text the engine writes is built here from graph nodes, so the verifier can rebuild it and compare
// (PLAN.md Phase 4: a claim equal to its template is proven by rule).

type Step = Flow['steps'][number];

export const evidenceOf = (node: GraphNode): Evidence => ({ type: 'code', node_id: node.id, ref: `${node.file}:${node.line}` });

export function label(node: GraphNode): string {
  switch (node.kind) {
    case 'page':
    case 'layout':
      return node.attrs.path;
    case 'route':
    case 'api-call':
      return `${node.attrs.method} ${node.attrs.path}`;
    case 'form':
    case 'response':
      return node.id.split(':').slice(2).join(':');
    default:
      return node.attrs.name;
  }
}

// For the Decider's input: "LoginForm#form" -> "login form", "submitCreateGame" -> "submit create game".
export const words = (identifier: string): string =>
  identifier
    .replace(/#form\d*$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[#._@-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const OWNERS = new Set(['component', 'page', 'layout']);

// A generated Log-in step starts with this; a subflow step a person makes says which flow it runs.
export const LOGIN_CLAIM = 'Log in first:';
export const runClaim = (name: string): string => `Run "${name}"`;
export const isRunClaim = (claim: string): boolean => /^Run ".+"$/.test(claim);

// The template claim for a step citing these nodes (in this order), or undefined when they fit none.
export function claimOf(kind: Step['kind'], nodes: readonly GraphNode[]): string | undefined {
  if (kind === 'subflow') return nodes.length > 0 && nodes.every((node) => node.kind === 'guard') ? `${LOGIN_CLAIM} guarded by ${nodes.map(label).join(', ')}` : undefined;
  const [first, second, ...rest] = nodes;
  if (first === undefined || rest.length > 0) return undefined;
  if (kind === 'ui' && first.kind === 'page' && second === undefined) return `Open ${label(first)}`;
  if (kind === 'ui' && first.kind === 'form' && (second === undefined || second.kind === 'action')) {
    const fields = first.attrs.fields.length > 0 ? ` (${first.attrs.fields.join(', ')})` : '';
    return `Fill in and submit ${label(first)}${fields}${second === undefined ? '' : `, which runs ${label(second)}`}`;
  }
  if (kind === 'ui' && first.kind === 'action' && second !== undefined && OWNERS.has(second.kind)) return `Click in ${label(second)} to run ${label(first)}`;
  if (kind === 'api' && first.kind === 'api-call' && second === undefined) return `Calls ${label(first)}`;
  if (kind === 'api' && first.kind === 'route' && (second === undefined || second.kind === 'handler')) {
    // An inline handler is named after its route, so naming it again says nothing.
    return `Call ${label(first)}${second === undefined || label(second) === label(first) ? '' : ` (handled by ${label(second)})`}`;
  }
  return undefined;
}

// What a node is, as a sentence: the premise when a claim is checked against evidence that fits no template.
export function sentence(node: GraphNode): string {
  switch (node.kind) {
    case 'form':
      return `The form ${label(node)}${node.attrs.fields.length > 0 ? ` with the fields ${node.attrs.fields.join(', ')}` : ''}.`;
    case 'action':
      return `The ${node.attrs.server ? 'server action' : 'action'} ${label(node)}.`;
    case 'api-call':
      return `A call to ${label(node)}.`;
    case 'response':
      return `A response with status ${node.attrs.status ?? 'unknown'}${node.attrs.fields.length > 0 ? ` and the fields ${node.attrs.fields.join(', ')}` : ''}.`;
    default:
      return `The ${node.kind} ${label(node)}.`;
  }
}

export const premiseOf = (kind: Step['kind'], nodes: readonly GraphNode[]): string => claimOf(kind, nodes) ?? nodes.map(sentence).join(' ');

const nodesOf = (step: Step, graph: Lookup): GraphNode[] => step.evidence.flatMap((item) => (item.type === 'code' ? (graph.node(item.node_id) ?? []) : []));

// The parts every flow is named and classified by: its entry (page or route), the step the user acts in, its API call.
export function shape(flow: Pick<Flow, 'steps'>, graph: Lookup) {
  const steps = flow.steps.filter((step) => step.kind !== 'subflow').map((step) => ({ step, nodes: nodesOf(step, graph) }));
  const entry = steps[0]?.nodes[0];
  const act = steps.find(({ step, nodes }) => step.kind === 'ui' && (nodes[0]?.kind === 'form' || nodes[0]?.kind === 'action'));
  const call = act === undefined ? undefined : steps.slice(steps.indexOf(act) + 1).find(({ step }) => step.kind === 'api')?.nodes[0];
  return { entry, act: act?.nodes ?? [], call };
}

// The template name, or undefined when the flow doesn't start at a page or a route.
export function flowName(flow: Pick<Flow, 'steps'>, graph: Lookup): string | undefined {
  const { entry, act, call } = shape(flow, graph);
  if (entry?.kind === 'route') return label(entry);
  if (entry?.kind !== 'page') return undefined;
  const target = call === undefined ? '' : ` (${label(call)})`;
  if (act[0]?.kind === 'form') return `Submit ${label(act[0])} on ${label(entry)}${target}`;
  if (act[0]?.kind === 'action') return `Click ${label(act[0])} on ${label(entry)}${target}`;
  return `Open ${label(entry)}`;
}

// One line per flow for the Decider (destructive-risk, flow-category), in the format of the tasks' examples.
export function deciderText(flow: Pick<Flow, 'steps'>, graph: Lookup): string {
  const { entry, act, call } = shape(flow, graph);
  if (entry?.kind === 'route') {
    const handler = graph.out(entry.id, 'handled-by')[0];
    return `${label(entry)}${handler === undefined || label(handler) === label(entry) ? '' : ` -> ${words(label(handler))}`}`;
  }
  const page = entry === undefined ? '' : ` on ${label(entry)}`;
  const then = call === undefined ? '' : ` -> ${label(call)}`;
  const [first, second] = act;
  if (first?.kind === 'form') {
    return `form: ${words(label(first))} (${first.attrs.fields.map(words).join(', ')})${second === undefined ? '' : ` -> ${words(label(second))}`}${then}${page}`;
  }
  if (first?.kind === 'action') return `click: ${words(label(first))}${then}${page}`;
  // A view: what the page renders, and what it calls on load (a load call can change data too).
  const parts = entry === undefined ? [] : graph.out(entry.id, 'renders').map((node) => words(label(node)));
  const loads = flow.steps.flatMap((step) => (step.kind === 'api' && step.request !== undefined ? [`${step.request.method} ${step.request.path}`] : []));
  return `page: ${entry === undefined ? '?' : label(entry)}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${loads.length > 0 ? ` -> ${loads.join(', ')}` : ''}`;
}
