// A UI flow's API calls are linked to the backend routes that answer them, and a call none answers is flagged.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { lookup } from '../graph/lookup.ts';
import type { Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import type { Flow } from '../model/flow.ts';
import { NO_ROUTE } from '../model/tags.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { backendOf, linkCalls } from './backend.ts';
import { buildFlows, type HumanInput } from './engine.ts';
import { OptionalLlm } from './llm.ts';
import { verifyFlows } from './verify.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-backend-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const project = tempProject(join(tmp, 'project'));
async function graphOf(path: string, role: 'web' | 'api'): Promise<Graph> {
  const repo = addRepo(project, join(root, path), role).config.repos.find((own) => own.role === role && own.path.endsWith(path.split('/').slice(-1)[0]));
  assert.ok(repo);
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  return graph;
}

const answer = (label: string) => ({ label, prob: 1, all_probs: { [label]: 1 }, version: 'stub' });
const unsure: Decider = { decide: async (task) => answer(task === 'destructive-risk' ? 'safe' : 'unknown') };
const deps = () => ({ decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => {}), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine });
const none: HumanInput = { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } };
const calls = (flow: Flow) => flow.steps.filter((step) => step.kind === 'api');

test("the quickstart: every call is answered by its route, with the route's check, errors and body", async () => {
  const [web, api] = [await graphOf('examples/quickstart/web', 'web'), await graphOf('examples/quickstart/api', 'api')];
  const set = await buildFlows(web, none, deps(), undefined, [api]);
  assert.ok(set.flows.every((flow) => !flow.tags.includes(NO_ROUTE)));
  const steps = set.flows.flatMap(calls);
  assert.equal(steps.length, 9);
  assert.ok(steps.every((step) => step.answered_by !== undefined && step.check !== null));
  const profile = steps.find((step) => step.request?.path === '/api/v1/users/me');
  assert.deepEqual(profile?.answered_by?.evidence.map((item) => (item.type === 'code' ? item.node_id : '')), ['api:route:PATCH /api/v1/users/me'], '/users/me, not /users/:id');
  assert.deepEqual(profile?.request?.body?.fields.map((field) => field.name), ['name', 'email']);
  assert.ok(profile?.errors?.some((error) => error.kind === 'api' && error.status === 401 && error.by === 'requireAuth'));
});

test('the fixtures: calls no route answers are tagged and say why; nothing is borrowed for them', async () => {
  const [web, api] = [await graphOf('fixtures/apps/next-basic', 'web'), await graphOf('fixtures/apps/express-basic', 'api')];
  const set = await buildFlows(web, none, deps(), undefined, [api]);
  const login = set.flows.find((flow) => flow.id === 'ui-082b51bb');
  assert.ok(login !== undefined && login.tags.includes(NO_ROUTE));
  assert.ok(set.reasons['ui-082b51bb'].includes('s3 POST /api/auth/login: no route of the API repos answers it'));
  assert.deepEqual(calls(login).map((step) => [step.answered_by, step.check]), [[undefined, null]]);
  const alone = await buildFlows(web, none, deps());
  assert.ok(alone.flows.every((flow) => !flow.tags.includes(NO_ROUTE)), 'with no API repo there is nothing to compare');
});

test('a link to the wrong route, or a borrowed error the route never sends, is dropped with the reason', async () => {
  const [web, api] = [await graphOf('examples/quickstart/web', 'web'), await graphOf('examples/quickstart/api', 'api')];
  const backend = backendOf([api]);
  assert.ok(backend);
  const set = await buildFlows(web, none, deps(), undefined, [api]);
  const cart = structuredClone(set.flows.find((flow) => calls(flow).some((step) => step.request?.path === '/api/v1/cart/items')) as Flow);
  const call = calls(linkCalls(cart, backend))[0];
  const first = call.errors?.[0];
  assert.ok(call.answered_by !== undefined && call.errors !== undefined && first?.kind === 'api');
  call.errors.push({ ...first, status: 418 });
  const wrong = structuredClone(cart);
  const index = wrong.steps.findIndex((step) => step.kind === 'api');
  wrong.steps[index] = { ...structuredClone(call), answered_by: { flow: 'api-00000000', evidence: [{ type: 'code', node_id: 'api:route:GET /api/v1/cart', ref: call.answered_by.evidence[0].ref }] } };
  cart.steps[index] = call;
  const context = { graph: web, nodes: lookup(web), grounding: unsure, maxDepth: 3, backend };
  const [kept, unlinked] = await verifyFlows([cart, wrong], context);
  assert.ok(kept.ok && unlinked.ok);
  assert.equal(calls(kept.flow)[0].errors?.some((error) => error.kind === 'api' && error.status === 418), false);
  assert.ok(kept.reasons.some((reason) => reason.includes('error dropped')));
  assert.deepEqual([calls(unlinked.flow)[0].answered_by, calls(unlinked.flow)[0].check], [undefined, null]);
  assert.ok(unlinked.reasons.some((reason) => reason.includes('backend route dropped')));
});
