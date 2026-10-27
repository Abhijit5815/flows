// What a test needs to run a flow, added after the flows are built: path parameters with their type and an example a
// live run used, and how the Log-in step's session is carried.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carriesOf } from '../adapters/hints.ts';
import { addRepo } from '../config/project.ts';
import { lookup } from '../graph/lookup.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import type { Live } from '../live/crosscheck.ts';
import { tempProject } from '../shared/testing/project.ts';
import { candidates } from './candidates.ts';
import { enrich } from './enrich.ts';
import { addLoginSubflows } from './subflows.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-enrich-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("a guarded route's Log-in step says how to carry the session; its params have a type, and a live run's value", async () => {
  const project = tempProject(join(tmp, 'project'));
  const fixture = fileURLToPath(new URL('../../fixtures/apps/express-basic/', import.meta.url));
  const { graph } = await scanRepo(project, addRepo(project, fixture, 'api').config.repos[0]);
  assert.ok(graph);
  const nodes = lookup(graph);
  const { flows } = addLoginSubflows(candidates(graph).flows, nodes);
  // Only what enrich reads of a run: the URLs it requested. A full Run has much more.
  const live = { runs: [{ requests: [{ method: 'GET', url: 'http://localhost:4000/api/v1/orders/42' }], states: [] }] } as unknown as Live;
  const order = enrich(flows, nodes, undefined, live).find((flow) => flow.name === 'GET /api/v1/orders/:orderId');
  assert.deepEqual(order?.steps[0].session, { header: 'Authorization', scheme: 'Bearer', token: 'data.token' }, 'the token is under data, where ok() puts it');
  assert.deepEqual(order?.steps[1].params, [{ name: 'orderId', type: 'number', example: '42' }], 'Number(req.params.orderId) makes it a number');
  const without = enrich(flows, nodes, undefined, undefined).find((flow) => flow.name === 'GET /api/v1/orders/:orderId');
  assert.deepEqual(without?.steps[1].params, [{ name: 'orderId', type: 'number' }], 'no live run, no example: none is made up');
});

test('how a guard reads the session, from its code', () => {
  assert.deepEqual(carriesOf("const token = req.headers.authorization?.replace('Bearer ', '');"), { header: 'Authorization', scheme: 'Bearer' });
  assert.deepEqual(carriesOf("jwtFromRequest: ExtractJwt.fromAuthHeaderWithScheme('Token')"), { header: 'Authorization', scheme: 'Token' });
  assert.deepEqual(carriesOf("if (!request.cookies.has('session')) return redirect('/login');"), { cookie: 'session' });
  assert.deepEqual(carriesOf("const key = req.headers['x-api-key'];"), { header: 'x-api-key' });
  assert.equal(carriesOf('return next();'), undefined);
});
