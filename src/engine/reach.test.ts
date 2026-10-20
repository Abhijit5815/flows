import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from '../graph/lookup.ts';
import { GraphSchema } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';
import { reachability, unreachableBecause } from './reach.ts';

const graph = GraphSchema.parse({
  role: 'api',
  repo: 'api',
  framework: 'express',
  nodes: [
    { id: 'api:route:GET /items', kind: 'route', file: 'src/a.ts', line: 1, attrs: { method: 'GET', path: '/items' } },
    { id: 'api:handler:list', kind: 'handler', file: 'src/a.ts', line: 2, attrs: { name: 'list' } },
    { id: 'api:response:list#200', kind: 'response', file: 'src/a.ts', line: 3, attrs: { status: 200, fields: ['items'] } },
    { id: 'api:model:Item', kind: 'model', file: 'prisma/schema.prisma', line: 1, attrs: { name: 'Item' } },
    { id: 'api:model:Audit', kind: 'model', file: 'prisma/schema.prisma', line: 9, attrs: { name: 'Audit' } },
  ],
  edges: [
    { from: 'api:route:GET /items', to: 'api:handler:list', kind: 'handled-by' },
    { from: 'api:handler:list', to: 'api:response:list#200', kind: 'responds-with' },
    { from: 'api:handler:list', to: 'api:model:Item', kind: 'touches' },
  ],
});
const reach = reachability(graph, lookup(graph));

const flowCiting = (...ids: string[]) =>
  ({ steps: [{ id: 's1', kind: 'api', claim: 'x', request: { method: 'GET', path: '/items' }, evidence: ids.map((id) => ({ type: 'code', node_id: id, ref: 'src/a.ts:1' })), check: null, enabled: true }] }) as unknown as Flow;

test('code no entry point leads to is listed as unreachable', () => {
  assert.deepEqual(reach.unreachable, ['api:model:Audit']);
});

test('a flow must start at an entry point and cite only what it leads to', () => {
  assert.equal(unreachableBecause(flowCiting('api:route:GET /items', 'api:handler:list', 'api:response:list#200'), reach), undefined);
  assert.equal(unreachableBecause(flowCiting('api:handler:list'), reach), 'it does not start at a page or a route');
  assert.match(unreachableBecause(flowCiting('api:route:GET /items', 'api:model:Audit'), reach) ?? '', /does not lead to/);
});
