import type { Lookup } from '../graph/lookup.ts';
import type { Graph } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';
import { LOGIN_CLAIM } from './describe.ts';

export type Reach = { entries: ReadonlySet<string>; from(entry: string): ReadonlySet<string>; unreachable: string[]; nodes: ReadonlySet<string> };

// PLAN.md Phase 4 static reachability. Entry points are what the router serves: every page (Next.js routes by file)
// and every route (the adapter keeps only routes mounted on the app). Nodes no entry leads to are unreachable code.
export function reachability(graph: Graph, nodes: Lookup): Reach {
  const entries = new Set(graph.nodes.filter((node) => node.kind === (graph.role === 'web' ? 'page' : 'route')).map((node) => node.id));
  const memo = new Map<string, Set<string>>();
  const from = (entry: string): Set<string> => {
    let seen = memo.get(entry);
    if (seen === undefined) {
      seen = new Set<string>();
      for (const queue = [entry]; queue.length > 0; ) {
        const id = queue.shift() as string; // safe: the queue is not empty
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(...nodes.out(id).map((node) => node.id));
      }
      memo.set(entry, seen);
    }
    return seen;
  };
  const reached = new Set([...entries].flatMap((entry) => [...from(entry)]));
  return { entries, from, unreachable: graph.nodes.filter((node) => !reached.has(node.id)).map((node) => node.id), nodes: new Set(graph.nodes.map((node) => node.id)) };
}

// Walks a flow's steps the way a user goes through them and returns why a step can't be reached, or where the
// flow ends up. Each step must be reachable from the current starting point: the flow's first page or route, or,
// after a step that runs another flow, where that flow ended. A flow a person wrote may also go to a new page or
// route on its own (a person can type a URL); a generated one may not, since nothing in the graph links two pages.
function walk(flow: Flow, reach: Reach, flows: ReadonlyMap<string, Flow>, ownSegments: boolean, seen: ReadonlySet<string>): { problem?: string; end?: string } {
  let entry: string | undefined;
  for (const step of flow.steps) {
    if (step.kind === 'subflow') {
      const target = step.claim.startsWith(LOGIN_CLAIM) ? undefined : flows.get(step.subflow_ref ?? '');
      if (target !== undefined && !seen.has(target.id)) entry = walk(target, reach, flows, true, new Set([...seen, target.id])).end ?? entry;
      continue;
    }
    const first = step.evidence[0]?.type === 'code' ? step.evidence[0].node_id : undefined;
    if (first !== undefined && reach.entries.has(first) && (entry === undefined || ownSegments)) entry = first;
    if (entry === undefined) return { problem: 'it does not start at a page or a route' };
    const reached = reach.from(entry);
    for (const item of [...step.evidence, ...(step.check?.evidence ?? [])]) {
      if (item.type === 'code' && reach.nodes.has(item.node_id) && !reached.has(item.node_id)) return { problem: `${step.id} cites ${item.node_id}, which ${entry} does not lead to` };
    }
  }
  return { end: entry };
}

// A flow must start at an entry point, and everything its own steps cite must be reachable from there. A subflow
// step is reached through its target's own entry, and a node the graph doesn't have is the verifier's to report.
// flows: the repo's flows by id; human: a person wrote the steps (see walk).
export function unreachableBecause(flow: Flow, reach: Reach, flows: ReadonlyMap<string, Flow> = new Map(), human = false): string | undefined {
  if (flow.steps.every((step) => step.kind === 'subflow')) return undefined; // made of subflows, each reached on its own
  return walk(flow, reach, flows, human, new Set([flow.id])).problem;
}
