import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // Pattern search (no embedding model here): listed for review, and none of it is in the graph.
  assert.deepEqual(coverage.missed.map((suspect) => `${suspect.file}:${suspect.line}`), expected.missed);
  assert.ok(coverage.missed.every((suspect) => !graph.nodes.some((node) => node.file === suspect.file && node.line === suspect.line)));
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

// Request bodies: the fields of a Zod object, through the schemas it is derived from.
test('a body schema gives its fields, through extend, omit, partial, enum and default', async () => {
  const dir = join(tmp, 'zod-app');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.19.2', zod: '^3.23.0' } }));
  writeFileSync(
    join(dir, 'src', 'server.ts'),
    `import express from 'express';
import { z } from 'zod';
const app = express();
const Base = z.object({ name: z.string().min(1), role: z.enum(['admin', 'user']).default('user'), age: z.number().int().optional() });
const Create = Base.extend({ email: z.string().email() }).omit({ age: true });
const Update = Create.partial();
app.post('/people', (req, res) => { Create.parse(req.body); res.status(201).json({ ok: true }); });
app.patch('/people/:id', (req, res) => { Update.parse(req.body); res.json({ ok: true }); });
app.listen(3000);
`,
  );
  const project = tempProject(join(tmp, 'zod'));
  const { graph } = await scanRepo(project, addRepo(project, dir, 'api').config.repos[0]);
  const fields = (name: string) => graph?.nodes.find((node) => node.kind === 'request-schema' && node.attrs.name === name)?.attrs;
  assert.deepEqual(fields('Create'), {
    name: 'Create',
    fields: [
      { name: 'name', type: 'string', required: true, rules: ['min(1)'] },
      { name: 'role', type: 'enum', required: false, rules: ["enum(['admin', 'user'])", "default('user')"] },
      { name: 'email', type: 'string', required: true, rules: ['email'] },
    ],
  });
  assert.deepEqual(
    (fields('Update') as { fields: { required: boolean }[] }).fields.map((field) => field.required),
    [false, false, false],
  );
});

// Patterns from apps Flows had never seen (RealWorld, bulletproof-nodejs): chained mounts, a router exported as an
// expression, routes registered by a default-exported function, and the app handed in through require().
test('chained mounts, default exports and an app passed in by type are all followed', async () => {
  const dir = join(tmp, 'mounts-app');
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { express: '^4.19.2' } }));
  write('src/app.ts', "import express from 'express';\nconst app = express();\nrequire('./loader').default({ app });\napp.listen(3000);\n");
  write('src/loader.ts', "import express from 'express';\nimport routes from './routes';\nexport default ({ app }: { app: express.Application }) => {\n  app.use('/api', routes);\n};\n");
  write('src/routes.ts', "import { Router } from 'express';\nimport tags from './tags';\nimport users from './users';\nconst api = Router().use(tags);\nusers(api);\nexport default Router().use('/v1', api);\n");
  write('src/tags.ts', "import { Router } from 'express';\nconst router = Router();\nrouter.get('/tags', (req, res) => { res.json({ tags: [] }); });\nexport default router;\n");
  write('src/users.ts', "import { Router } from 'express';\nconst route = Router();\nexport default (app: Router) => {\n  app.use('/users', route);\n  route.post('/login', (req, res) => { res.json({ token: 't' }); });\n};\n");
  const project = tempProject(join(tmp, 'mounts'));
  const { graph, coverage } = await scanRepo(project, addRepo(project, dir, 'api').config.repos[0]);
  assert.deepEqual(graph?.nodes.flatMap((node) => (node.kind === 'route' ? [`${node.attrs.method} ${node.attrs.path}`] : [])).sort(), ['GET /api/v1/tags', 'POST /api/v1/users/login']);
  assert.deepEqual(coverage.unrecognised, []);
});
