import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../../config/project.ts';
import { scanRepo } from '../../ingest/pipeline.ts';
import { tempProject } from '../../shared/testing/project.ts';
import { expressAdapter, joinPath } from './express.ts';
import { routeViews } from './views.ts';

const fixture = fileURLToPath(new URL('../../../fixtures/apps/express-basic/', import.meta.url));
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'flows-express-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const byRoute = (views: { route: string }[]) => [...views].sort((a, b) => a.route.localeCompare(b.route));

test('express fixture: every route, with its handler, guards, middleware, schemas, responses and models', async () => {
  const project = tempProject(join(tmp, 'fixture'));
  const repo = addRepo(project, fixture, 'api').config.repos[0];
  const { graph, coverage } = await scanRepo(project, repo);
  assert.ok(graph);
  assert.deepEqual(byRoute(routeViews(graph)), byRoute(expected.routes));
  const models = graph.nodes.filter((node) => node.kind === 'model').map((node) => `${node.attrs.name} @ ${node.file}:${node.line}`);
  assert.deepEqual(models.sort(), expected.models);
  assert.deepEqual(coverage.unrecognised.map((note) => `${note.file}:${note.line}`).sort(), expected.unrecognised);
});

test('paths join the way Express joins them', () => {
  assert.equal(joinPath('', '/api'), '/api');
  assert.equal(joinPath('/v1/games', '/'), '/v1/games');
  assert.equal(joinPath('/', '/signup'), '/signup');
  assert.equal(joinPath('', ''), '/');
  assert.equal(joinPath('/users', '/:id(\\d+)'), '/users/:id(\\d+)');
});

// The fixture test has to be able to fail: drop one rule and the routes it found must go missing.
test('a broken rule fails the fixture: without route-chain, the four chained routes are missing', async () => {
  const project = tempProject(join(tmp, 'broken'));
  const repo = addRepo(project, fixture, 'api').config.repos[0];
  const broken = { ...expressAdapter, rules: expressAdapter.rules.filter((rule) => rule.id !== 'route-chain') };
  const { graph } = await scanRepo(project, repo, { adapters: [broken] });
  assert.ok(graph);
  const found = new Set(routeViews(graph).map((view) => view.route));
  const missing = expected.routes.map((view: { route: string }) => view.route).filter((route: string) => !found.has(route));
  assert.deepEqual(missing.sort(), ['GET /api/v1/orders', 'GET /api/v1/users/:id', 'PATCH /api/v1/users/:id', 'POST /api/v1/orders']);
});

// A repo reached through a symlink (macOS's /tmp is one) must give the same graph: path aliases have to resolve to
// the same files the scan loads, or references between them are lost.
test('a repo path through a symlink gives the same graph', async () => {
  const linked = join(tmp, 'linked-express-basic');
  symlinkSync(fixture, linked);
  const project = tempProject(join(tmp, 'linked'));
  const { graph } = await scanRepo(project, addRepo(project, linked, 'api').config.repos[0]);
  assert.ok(graph);
  assert.deepEqual(byRoute(routeViews(graph)), byRoute(expected.routes));
});
