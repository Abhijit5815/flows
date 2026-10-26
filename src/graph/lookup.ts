import type { GraphNode } from './schema.ts';

export type Lookup = {
  node(id: string): GraphNode | undefined;
  out(id: string, kind?: string): GraphNode[]; // nodes this one points at, optionally along one edge kind
  into(id: string, kind?: string): GraphNode[]; // nodes that point at this one
};

// Edges indexed by node, so traversals don't rescan the edge list.
export function lookup(graph: { nodes: readonly GraphNode[]; edges: readonly { from: string; to: string; kind: string }[] }): Lookup {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, { kind: string; id: string }[]>();
  const incoming = new Map<string, { kind: string; id: string }[]>();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from)?.push({ kind: edge.kind, id: edge.to });
    incoming.get(edge.to)?.push({ kind: edge.kind, id: edge.from });
  }
  const along = (edges: { kind: string; id: string }[] | undefined, kind: string | undefined) =>
    (edges ?? []).flatMap((edge) => (kind === undefined || edge.kind === kind ? (nodes.get(edge.id) ?? []) : []));
  return {
    node: (id) => nodes.get(id),
    out: (id, kind) => along(outgoing.get(id), kind),
    into: (id, kind) => along(incoming.get(id), kind),
  };
}
