import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../config/project.ts';
import { lookup } from '../graph/lookup.ts';
import { GraphSchema, type Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { FlowSchema } from '../model/flow.ts';
import { tempProject } from '../shared/testing/project.ts';
import { candidates } from './candidates.ts';
import { addLoginSubflows } from './subflows.ts';
import { flowViews } from './views.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/apps/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-candidates-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function fixtureGraph(app: string, role: 'web' | 'api'): Promise<Graph> {
  const project = tempProject(join(tmp, app));
  const { graph } = await scanRepo(project, addRepo(project, join(fixtures, app), role).config.repos[0]);
  assert.ok(graph);
  return graph;
}

for (const [app, role] of [['express-basic', 'api'], ['next-basic', 'web']] as const) {
  test(`${app}: the flows, Log-in steps and skipped candidates in expected-flows.json`, async () => {
    const graph = await fixtureGraph(app, role);
    const expected = JSON.parse(readFileSync(join(fixtures, app, 'expected-flows.json'), 'utf8'));
    const found = candidates(graph);
    const { flows, notes } = addLoginSubflows(found.flows, lookup(graph));
    for (const flow of flows) FlowSchema.parse(flow);
    assert.deepEqual(flowViews(flows), expected.flows);
    assert.deepEqual(found.skipped.map((skip) => `${skip.node}: ${skip.reason}`), expected.skipped);
    assert.deepEqual(notes, expected.notes);
  });
}

// A small UI graph: one page, a form whose action can make two calls, two clicks, a call to another service.
type Row = [kind: string, key: string, attrs: object];
function webGraph(rows: Row[], edges: [string, string, string][]): Graph {
  const nodes = rows.map(([kind, key, attrs], i) => ({ id: `web:${kind}:${key}`, kind, file: 'app/page.tsx', line: i + 1, attrs }));
  return GraphSchema.parse({ role: 'web', repo: 'app', framework: 'nextjs-app', nodes, edges: edges.map(([from, kind, to]) => ({ from, kind, to })) });
}

const graph = webGraph(
  [
    ['page', '/', { path: '/' }],
    ['form', 'Auth#form', { fields: ['name'] }],
    ['action', 'submit', { name: 'submit', server: false }],
    ['api-call', 'POST /login', { method: 'POST', path: '/login' }],
    ['api-call', 'POST /register', { method: 'POST', path: '/register' }],
    ['action', 'toggle', { name: 'toggle', server: false }],
    ['action', 'track', { name: 'track', server: false }],
    ['api-call', 'POST https://stats.example.com/hit', { method: 'POST', path: 'https://stats.example.com/hit' }],
  ],
  [
    ['web:page:/', 'contains', 'web:form:Auth#form'],
    ['web:form:Auth#form', 'submits', 'web:action:submit'],
    ['web:action:submit', 'calls', 'web:api-call:POST /login'],
    ['web:action:submit', 'calls', 'web:api-call:POST /register'],
    ['web:page:/', 'triggers', 'web:action:toggle'],
    ['web:page:/', 'triggers', 'web:action:track'],
    ['web:action:track', 'calls', 'web:api-call:POST https://stats.example.com/hit'],
  ],
);

test('an action that can make several calls gives one flow per call; a click with no call is skipped', () => {
  const found = candidates(graph);
  assert.deepEqual(
    found.flows.map((flow) => flow.name),
    ['User can view the home page', 'User can submit the auth form (POST /login)', 'User can submit the auth form (POST /register)', 'User can track'],
  );
  assert.deepEqual(found.skipped.map((skip) => skip.node), ['web:action:toggle']);
});

test('a call to another service is left out of its flow and noted, not guessed', () => {
  const found = candidates(graph);
  const track = found.flows.find((flow) => flow.name === 'User can track');
  assert.ok(track);
  assert.deepEqual(track.steps.map((step) => step.kind), ['ui', 'ui']);
  assert.match(found.notes[track.id]?.[0] ?? '', /calls another service/);
});

test('with no login flow, or with two, guarded flows get no Log-in step and a note says why', () => {
  const guarded = webGraph(
    [
      ['page', '/admin', { path: '/admin' }],
      ['guard', 'middleware', { name: 'middleware' }],
      ['page', '/login', { path: '/login' }],
      ['form', 'LoginForm#form', { fields: ['email'] }],
      ['page', '/signin', { path: '/signin' }],
      ['form', 'SignInForm#form', { fields: ['email'] }],
    ],
    [
      ['web:page:/admin', 'guarded-by', 'web:guard:middleware'],
      ['web:page:/login', 'contains', 'web:form:LoginForm#form'],
      ['web:page:/signin', 'contains', 'web:form:SignInForm#form'],
    ],
  );
  const flows = candidates(guarded).flows;
  const two = addLoginSubflows(flows, lookup(guarded));
  assert.ok(two.flows.every((flow) => flow.steps.every((step) => step.kind !== 'subflow')));
  assert.match(two.notes[0], /2 flows look like logging in/);
  const none = addLoginSubflows(flows.filter((flow) => flow.name.startsWith('User can view')), lookup(guarded));
  assert.match(none.notes[0], /no login flow was found/);
});
