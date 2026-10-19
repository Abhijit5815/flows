import type { Graph, GraphNode } from '../../graph/schema.ts';

// The UI graph seen from each page and layout, in the shape of the fixture's expected.json: what it renders
// (transitively), its forms and actions, and the API calls each one makes.
export function uiViews(graph: Graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const out = (from: string, kind: string): GraphNode[] => graph.edges.filter((e) => e.from === from && e.kind === kind).flatMap((e) => byId.get(e.to) ?? []);
  const nameOf = (node: GraphNode) => node.id.split(':').slice(2).join(':');
  const label = (node: GraphNode) => `${nameOf(node)} @ ${node.file}:${node.line}`;
  const unique = (nodes: GraphNode[]) => [...new Map(nodes.map((node) => [node.id, node])).values()];

  const reach = (root: GraphNode) => {
    const components: GraphNode[] = [];
    const queue = [root];
    while (queue.length > 0) {
      for (const child of out((queue.shift() as GraphNode).id, 'renders')) {
        if (child.id === root.id || components.some((seen) => seen.id === child.id)) continue;
        components.push(child);
        queue.push(child);
      }
    }
    const owners = [root, ...components];
    const forms = unique(owners.flatMap((owner) => out(owner.id, 'contains')));
    const actions = unique([...forms.flatMap((form) => out(form.id, 'submits')), ...owners.flatMap((owner) => out(owner.id, 'triggers'))]);
    return {
      components: components.map(label).sort(),
      forms: forms.map((form) => `${label(form)} [${form.kind === 'form' ? form.attrs.fields.join(',') : ''}] -> ${out(form.id, 'submits').map(nameOf).sort().join(', ')}`).sort(),
      actions: actions
        .map((action) => `${nameOf(action)} (${action.kind === 'action' && action.attrs.server ? 'server' : 'client'}) @ ${action.file}:${action.line} -> ${out(action.id, 'calls').map(nameOf).sort().join(', ') || '(no API call)'}`)
        .sort(),
      calls: unique(owners.flatMap((owner) => out(owner.id, 'calls'))).map(label).sort(),
    };
  };

  const pages = graph.nodes.flatMap((page) =>
    page.kind === 'page'
      ? [{ page: page.attrs.path, at: `${page.file}:${page.line}`, layouts: out(page.id, 'wrapped-by').map(label).sort(), guards: out(page.id, 'guarded-by').map(label).sort(), ...reach(page) }]
      : [],
  );
  const layouts = graph.nodes.flatMap((layout) => (layout.kind === 'layout' ? [{ layout: nameOf(layout), at: `${layout.file}:${layout.line}`, ...reach(layout) }] : []));
  return { pages, layouts };
}
