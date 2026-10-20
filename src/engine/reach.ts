import type { Lookup } from '../graph/lookup.ts';
import type { Graph } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';

export type Reach = { entries: ReadonlySet<string>; from(entry: string): ReadonlySet<string>; unreachable: string[] };

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
  return { entries, from, unreachable: graph.nodes.filter((node) => !reached.has(node.id)).map((node) => node.id) };
}

// A flow must start at an entry point, and everything it cites must be reachable from there.
export function unreachableBecause(flow: Flow, reach: Reach): string | undefined {
  const first = flow.steps.find((step) => step.kind !== 'subflow')?.evidence[0];
  const entry = first?.type === 'code' ? first.node_id : undefined;
  if (entry === undefined || !reach.entries.has(entry)) return 'it does not start at a page or a route';
  const reached = reach.from(entry);
  for (const step of flow.steps) {
    for (const item of [...step.evidence, ...(step.check?.evidence ?? [])]) {
      if (item.type === 'code' && !reached.has(item.node_id)) return `${step.id} cites ${item.node_id}, which ${entry} does not lead to`;
    }
  }
  return undefined;
}
