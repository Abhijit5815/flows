import type { Role } from '../config/project.ts';
import { GraphSchema, nodeId, type Graph, type GraphNode } from './schema.ts';

type Pending = { kind: GraphNode['kind']; name: string; file: string; line: number; attrs: Record<string, unknown> };

// Collects nodes under the adapter's own identity keys (one per real thing, e.g. a declaration), then gives
// each a readable id. Two different things with the same name get the file added: "api:handler:list@src/a.ts".
export class GraphBuilder {
  private readonly nodes = new Map<string, Pending>();
  private readonly edges = new Map<string, { from: string; to: string; kind: string }>();

  // The first add for a key wins; later adds of the same thing (a handler used by two routes) only return the key.
  add(key: string, node: Pending): string {
    if (!this.nodes.has(key)) this.nodes.set(key, node);
    return key;
  }

  get(key: string): Pending | undefined {
    return this.nodes.get(key);
  }

  edge(from: string, to: string, kind: string): void {
    this.edges.set(`${from}\0${to}\0${kind}`, { from, to, kind });
  }

  build(role: Role, repo: string, framework: string): Graph {
    const ids = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const [key, node] of this.nodes) byName.set(`${node.kind}:${node.name}`, [...(byName.get(`${node.kind}:${node.name}`) ?? []), key]);
    for (const keys of byName.values()) {
      const files = new Set(keys.map((key) => this.nodes.get(key)?.file));
      keys.forEach((key, i) => {
        const node = this.nodes.get(key) as Pending; // safe: keys come from this.nodes
        const suffix = keys.length === 1 ? '' : files.size === keys.length ? `@${node.file}` : `@${node.file}#${i + 1}`;
        ids.set(key, nodeId(role, node.kind, `${node.name}${suffix}`));
      });
    }
    const nodes = [...this.nodes].map(([key, node]) => ({ id: ids.get(key), kind: node.kind, file: node.file, line: node.line, attrs: node.attrs }));
    const edges = [...this.edges.values()].map((edge) => ({ from: ids.get(edge.from), to: ids.get(edge.to), kind: edge.kind }));
    // The schema checks what the adapter built: kinds, attributes, unique ids, edges inside this graph.
    return GraphSchema.parse({ role, repo, framework, nodes, edges });
  }
}
