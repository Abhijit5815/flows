import type { Graph, GraphNode } from '../../graph/schema.ts';

// One line per route with everything hanging off it, in the same shape as expected.json.
export function routeViews(graph: Graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const out = (from: string, kind: string): GraphNode[] => graph.edges.filter((e) => e.from === from && e.kind === kind).flatMap((e) => byId.get(e.to) ?? []);
  const label = (node: GraphNode) => `${'name' in node.attrs ? node.attrs.name : node.id} @ ${node.file}:${node.line}`;
  return graph.nodes.flatMap((route) => {
    if (route.kind !== 'route') return [];
    const [handler] = out(route.id, 'handled-by');
    const responses = handler === undefined ? [] : out(handler.id, 'responds-with');
    return [{
      route: `${route.attrs.method} ${route.attrs.path}`,
      at: `${route.file}:${route.line}`,
      handler: handler === undefined ? null : label(handler),
      guards: out(route.id, 'guarded-by').map(label).sort(),
      middleware: out(route.id, 'uses').map(label).sort(),
      schemas: out(route.id, 'validated-by').map(label).sort(),
      responses: responses.flatMap((r) => (r.kind === 'response' ? [`${r.attrs.status ?? '?'}${r.attrs.fields.length > 0 ? ` ${r.attrs.fields.join(',')}` : ''}`] : [])).sort(),
      models: handler === undefined ? [] : out(handler.id, 'touches').map(label).sort(),
    }];
  });
}
