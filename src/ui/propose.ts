import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { embedEach } from '../embeddings/vector-cache.ts';
import { callStep, draft, openStep, routeStep, uiStep, type DraftStep } from '../engine/candidates.ts';
import { label, sentence, words } from '../engine/describe.ts';
import { reachability } from '../engine/reach.ts';
import { addLoginSubflows } from '../engine/subflows.ts';
import { lookup, type Lookup } from '../graph/lookup.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';

// The nodes a step can be made of, per graph role.
const PICKABLE: Record<Graph['role'], ReadonlySet<string>> = { web: new Set(['page', 'form', 'action', 'api-call']), api: new Set(['route']) };

export type PaletteNode = { id: string; kind: string; label: string; at: string };

export const palette = (graph: Graph): PaletteNode[] =>
  graph.nodes.filter((node) => PICKABLE[graph.role].has(node.kind)).map((node) => ({ id: node.id, kind: node.kind, label: label(node), at: `${node.file}:${node.line}` }));

// The step a node becomes: a form runs what it submits; an action is clicked where something triggers it.
function stepFor(node: GraphNode, nodes: Lookup): DraftStep | string {
  if (node.kind === 'page') return openStep(node);
  if (node.kind === 'form') {
    const action = nodes.out(node.id, 'submits')[0];
    return uiStep(action === undefined ? [node] : [node, action]);
  }
  if (node.kind === 'action') {
    const owner = nodes.into(node.id, 'triggers')[0];
    return owner === undefined ? `${label(node)} runs when a form is submitted; pick the form instead` : uiStep([node, owner]);
  }
  if (node.kind === 'api-call') return callStep(node);
  if (node.kind === 'route') return routeStep(node, nodes);
  return `a ${node.kind} can't be a step of its own`;
}

// A flow that starts behind a guard gets the same Log-in step the scan gives generated flows (the repo's flows say
// which one logs in); the person can remove it like any other step.
const withLogin = (flow: Flow, graph: Graph, flows: readonly Flow[]): Flow =>
  addLoginSubflows([...flows.filter((own) => own.id !== flow.id), flow], lookup(graph)).flows.find((own) => own.id === flow.id) ?? flow;

// PLAN.md Phase 5 "draw it": the picked nodes become the flow's steps, in order. The engine checks the flow like any
// other when it is saved.
export function drawFlow(graph: Graph, ids: readonly string[], name: string, flows: readonly Flow[]): Flow | string {
  const nodes = lookup(graph);
  const steps: DraftStep[] = [];
  for (const id of ids) {
    const node = nodes.node(id);
    if (node === undefined) return `${id} is not in the ${graph.role} graph`;
    const step = stepFor(node, nodes);
    if (typeof step === 'string') return step;
    steps.push(step);
  }
  if (steps.length === 0) return 'pick at least one node';
  return withLogin({ ...draft(graph.role === 'web' ? 'ui' : 'api', `drawn|${ids.join('|')}`, steps, nodes), name }, graph, flows);
}

export type Described = { flow?: Flow; closest: { label: string; at: string; similarity: number }[]; message: string };

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i], 0);

// PLAN.md Phase 5 "describe it": the description is matched against what each node is, by the embedding model. The
// best match becomes the proposal, from the page that leads to it (and with the API call its action makes). Below
// the threshold nothing is proposed; the closest matches are listed instead. No LLM is involved.
export async function describeFlow(graph: Graph, text: string, flows: readonly Flow[], embedder: EmbeddingProvider, cacheFile: string, minSimilarity: number): Promise<Described> {
  const nodes = lookup(graph);
  const pickable = graph.nodes.filter((node) => PICKABLE[graph.role].has(node.kind));
  if (pickable.length === 0) return { closest: [], message: 'The graph has nothing a flow could start from; run "flows scan".' };
  const vectors = await embedEach(cacheFile, pickable.map((node) => `${sentence(node)} (${words(label(node))})`), embedder);
  const [query] = await embedder.embed([text]);
  const scored = pickable.map((node, i) => ({ node, similarity: dot(query, vectors[i]) })).sort((a, b) => b.similarity - a.similarity);
  const closest = scored.slice(0, 5).map(({ node, similarity }) => ({ label: `${node.kind} ${label(node)}`, at: `${node.file}:${node.line}`, similarity: Math.round(similarity * 100) / 100 }));
  const best = scored[0];
  if (best.similarity < minSimilarity) {
    return { closest, message: `Nothing in the code matches "${text}" closely enough: the best match scores ${best.similarity.toFixed(2)}, below ${minSimilarity}.` };
  }
  const steps: DraftStep[] = [];
  const add = (step: DraftStep | string) => typeof step === 'string' || steps.push(step);
  if (graph.role === 'api') add(stepFor(best.node, nodes));
  else {
    // The shortest page that leads to the match is where the flow starts.
    const reach = reachability(graph, nodes);
    const page = graph.nodes
      .filter((node) => node.kind === 'page')
      .sort((a, b) => label(a).length - label(b).length)
      .find((candidate) => reach.from(candidate.id).has(best.node.id));
    if (page === undefined) return { closest, message: `The best match, ${label(best.node)}, isn't reached from any page.` };
    add(openStep(page));
    // An API call stands for the action (or the page) that makes it.
    const acting = best.node.kind === 'api-call' ? (nodes.into(best.node.id, 'calls').find((caller) => caller.kind === 'action') ?? page) : best.node;
    if (acting.kind === 'action' && nodes.into(acting.id, 'triggers').length === 0) add(stepFor(nodes.into(acting.id, 'submits')[0] ?? acting, nodes));
    else if (acting !== page) add(stepFor(acting, nodes));
    const call = best.node.kind === 'api-call' ? best.node : acting.kind === 'action' ? nodes.out(acting.id, 'calls')[0] : acting.kind === 'form' ? nodes.out(nodes.out(acting.id, 'submits')[0]?.id ?? '', 'calls')[0] : undefined;
    if (call !== undefined) add(callStep(call));
  }
  if (steps.length === 0) return { closest, message: `The best match, ${label(best.node)}, can't be made into a step.` };
  const flow = withLogin({ ...draft(graph.role === 'web' ? 'ui' : 'api', `described|${text}`, steps, nodes), name: text }, graph, flows);
  return { flow, closest, message: `Built from the best match, ${best.node.kind} ${label(best.node)} (similarity ${best.similarity.toFixed(2)}).` };
}
