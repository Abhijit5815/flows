import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { tempProject } from '../shared/testing/project.ts';
import { GraphSchema, nodeId, type Graph } from './schema.ts';
import { graphFile, loadGraph, saveGraph } from './store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-graph-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const route = nodeId('api', 'route', 'GET /v1/games/:code');
const handler = nodeId('api', 'handler', 'getGame');

function apiGraph(): Graph {
  return {
    role: 'api',
    repo: 'server',
    framework: 'express',
    nodes: [
      { id: route, kind: 'route', file: 'src/routes/games.route.ts', line: 9, attrs: { method: 'GET', path: '/v1/games/:code' } },
      { id: handler, kind: 'handler', file: 'src/controllers/games.ts', line: 30, attrs: { name: 'getGame' } },
    ],
    edges: [{ from: route, to: handler, kind: 'handled-by' }],
  };
}

const errors = (graph: unknown): string => {
  const result = GraphSchema.safeParse(graph);
  return result.success ? '' : z.prettifyError(result.error);
};

test('a well-formed graph is valid, and survives a save and load', () => {
  assert.equal(errors(apiGraph()), '');
  const project = tempProject(join(tmp, 'p1'));
  saveGraph(project, apiGraph());
  assert.deepEqual(loadGraph(project, { path: 'server', role: 'api' }), apiGraph());
});

// Each case breaks one rule the adapters must keep; the schema has to catch every one.
const broken: { rule: string; message: RegExp; breakIt: (graph: Graph) => void }[] = [
  { rule: 'node ids are unique', message: /duplicate node id/, breakIt: (g) => { g.nodes[1].id = route; } },
  { rule: 'edges join existing nodes', message: /not a node of this graph/, breakIt: (g) => { g.edges[0].to = 'api:handler:missing'; } },
  { rule: 'ids carry role and kind', message: /must start with "api:route:"/, breakIt: (g) => { g.nodes[0].id = 'web:route:GET /v1/games/:code'; } },
  { rule: 'no UI node kinds in the API graph', message: /kind/, breakIt: (g) => { Object.assign(g.nodes[1], { kind: 'page' }); } },
  { rule: 'no UI edge kinds in the API graph', message: /kind/, breakIt: (g) => { Object.assign(g.edges[0], { kind: 'renders' }); } },
  { rule: 'routes have a method from the list', message: /method/, breakIt: (g) => { Object.assign(g.nodes[0].attrs, { method: 'FETCH' }); } },
];

for (const { rule, message, breakIt } of broken) {
  test(`graph schema: ${rule}`, () => {
    const graph = apiGraph();
    breakIt(graph);
    assert.match(errors(graph), message);
  });
}

test('saving an invalid graph throws, and a damaged or missing file loads as nothing', () => {
  const project = tempProject(join(tmp, 'p2'));
  const graph = apiGraph();
  graph.edges[0].to = 'api:handler:missing';
  assert.throws(() => saveGraph(project, graph), z.ZodError);

  const repo = { path: 'server', role: 'api' as const };
  assert.equal(loadGraph(project, repo), undefined);
  saveGraph(project, apiGraph());
  writeFileSync(graphFile(project, repo), '{ damaged');
  assert.equal(loadGraph(project, repo), undefined);
});
