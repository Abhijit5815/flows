import { z } from 'zod';
import type { Role } from '../config/project.ts';
import { FieldSchema, HTTP_METHODS } from '../model/flow.ts';

// PLAN.md §4: one graph per registered repo. An api repo gives the API graph and a web repo the UI graph.
// Edges only join nodes of their own graph, so the two graphs are never linked.

const MethodSchema = z.enum([...HTTP_METHODS, 'ALL']);
const Named = z.object({ name: z.string().min(1) });

// Every node cites the file and line it was found on.
const node = <K extends string, A extends z.ZodType>(kind: K, attrs: A) =>
  z.object({ id: z.string().min(1), kind: z.literal(kind), file: z.string().min(1), line: z.int().min(1), attrs });

const ApiNodeSchema = z.discriminatedUnion('kind', [
  node('route', z.object({ method: MethodSchema, path: z.string().startsWith('/') })),
  node('handler', Named.extend({ numeric: z.array(z.string().min(1)).optional() })), // numeric: path params it reads as numbers
  node('guard', Named.extend({ carries: z.object({ header: z.string().optional(), scheme: z.string().optional(), cookie: z.string().optional() }).optional() })), // carries: what it reads the session from
  node('middleware', Named),
  node('request-schema', Named.extend({ fields: z.array(FieldSchema).optional() })), // fields: a Zod object Flows could read
  // messages: the string literals sent with it ("order not found"); guards and middleware respond too.
  // token: where a login's token is in the body ("data.token"); when: the condition each message is sent under.
  node('response', z.object({ status: z.int().min(100).max(599).optional(), fields: z.array(z.string().min(1)), messages: z.array(z.string().min(1)).optional(), token: z.string().min(1).optional(), when: z.record(z.string(), z.string()).optional() })),
  node('model', Named),
]);

const WebNodeSchema = z.discriminatedUnion('kind', [
  node('page', z.object({ path: z.string().startsWith('/') })),
  node('layout', z.object({ path: z.string().startsWith('/') })),
  node('component', Named),
  node('form', z.object({ fields: z.array(z.string().min(1)), submit: z.string().min(1).optional() })), // submit: its button's text
  // redirects: where it sends the browser (redirect('/account')); messages: the strings it returns for the form to show.
  node('action', z.object({ name: z.string().min(1), server: z.boolean(), redirects: z.array(z.string().startsWith('/')).optional(), messages: z.array(z.string().min(1)).optional(), text: z.string().min(1).optional(), library: z.string().min(1).optional() })),
  node('guard', Named.extend({ carries: z.object({ header: z.string().optional(), scheme: z.string().optional(), cookie: z.string().optional() }).optional() })),
  // Not linked in the graph; the flow engine links it to the route that answers it. The path may be a full URL (another service).
  node('api-call', z.object({ method: MethodSchema, path: z.string().min(1) })),
]);

const edge = <const K extends readonly [string, ...string[]]>(kinds: K) =>
  z.object({ from: z.string().min(1), to: z.string().min(1), kind: z.enum(kinds) });

const GraphBase = z.object({ repo: z.string().min(1), framework: z.string().min(1) });

export const GraphSchema = z
  .discriminatedUnion('role', [
    GraphBase.extend({
      role: z.literal('api'),
      nodes: z.array(ApiNodeSchema),
      edges: z.array(edge(['handled-by', 'guarded-by', 'uses', 'validated-by', 'responds-with', 'touches'])),
    }),
    GraphBase.extend({
      role: z.literal('web'),
      nodes: z.array(WebNodeSchema),
      edges: z.array(edge(['wrapped-by', 'renders', 'contains', 'submits', 'triggers', 'calls', 'guarded-by'])),
    }),
  ])
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    graph.nodes.forEach((n, i) => {
      if (!n.id.startsWith(`${graph.role}:${n.kind}:`)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `${n.id} must start with "${graph.role}:${n.kind}:"` });
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `duplicate node id ${n.id}` });
      ids.add(n.id);
    });
    graph.edges.forEach((e, i) => {
      for (const end of ['from', 'to'] as const) {
        if (!ids.has(e[end])) ctx.addIssue({ code: 'custom', path: ['edges', i, end], message: `${e[end]} is not a node of this graph` });
      }
    });
  });

export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = Graph['nodes'][number];

// Ids say what a node is, not where it is, so they survive edits: "api:route:GET /v1/games/:code", "web:page:/archive/[id]".
// Flow evidence cites them as node_id.
export const nodeId = (role: Role, kind: GraphNode['kind'], key: string): string => `${role}:${kind}:${key}`;
