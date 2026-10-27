// PLAN.md Phase 3 cross-check, end to end on the live fixture: two explorer runs (signed out, and signed in with env
// credentials) against the graphs of fixtures/apps/next-basic (UI) and express-basic (API), which the live
// fixture's pages and API follow.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveFixture, type LiveFixture } from '../../fixtures/live/server.ts';
import { addRepo, categories, type Project } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { buildFlows, type EngineDeps } from '../engine/engine.ts';
import { OptionalLlm } from '../engine/llm.ts';
import type { FlowSet } from '../engine/store.ts';
import type { Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { liveFor, NOT_OBSERVED, ROLE_NOT_EXPLORED } from './crosscheck.ts';
import { explore, type ExploreInput } from './explorer.ts';
import { runDir, saveRun } from './run.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/apps/', import.meta.url));
const options = { email: 'shopper@example.com', password: randomBytes(9).toString('hex'), secret: `tok_${randomBytes(16).toString('hex')}` };
const tmp = mkdtempSync(join(tmpdir(), 'flows-crosscheck-'));
let site: LiveFixture;
let project: Project;
let deps: EngineDeps;
const graphs: { repo: Project['config']['repos'][number]; graph: Graph }[] = [];
const sets: Record<'web' | 'api', FlowSet> = {} as Record<'web' | 'api', FlowSet>;

const answer = (label: string, prob: number) => ({ label, prob, all_probs: { [label]: prob }, version: 'stub' });
// A stand-in Decider (the real one is measured in accuracy.test.ts): deleting and cancelling are destructive,
// subscribing is safe but not sure enough, everything else is safe; tracking and health calls are noise.
const decider: Decider = {
  async decide(task, text) {
    if (task === 'event-noise') return answer(/track|health/.test(text) ? 'noise' : 'relevant', 0.9);
    if (task === 'flow-category') return answer('browse', 0.9);
    if (/delete|cancel/i.test(text)) return answer('destructive', 0.9);
    if (/subscribe/i.test(text)) return answer('safe', 0.6);
    return answer('safe', 0.95);
  },
};
const grounding: Decider = { decide: async () => answer('unsupported', 1) };

before(async () => {
  if (browserSkip !== false) return;
  site = await startLiveFixture(options);
  project = addRepo(addRepo(tempProject(join(tmp, 'project')), join(fixtures, 'next-basic'), 'web'), join(fixtures, 'express-basic'), 'api');
  for (const repo of project.config.repos) {
    const { graph } = await scanRepo(project, repo);
    assert.ok(graph);
    graphs.push({ repo, graph });
  }
  const llm = new OptionalLlm(undefined, join(tmp, 'llm.json'), () => undefined);
  const pages = graphs[0].graph.nodes.flatMap((node) => (node.kind === 'page' ? [node.attrs.path] : []));
  const input: ExploreInput = { url: site.url, session: null, storageState: undefined, credentials: undefined, saveSessionTo: undefined, pages, headless: true };
  const explorer = { decider, llm, config: project.config.explorer, runDir: (id: string) => runDir(project, id), log: () => undefined };
  saveRun(project, await explore(input, explorer));
  saveRun(project, await explore({ ...input, session: 'tester', credentials: { user: options.email, password: options.password, path: '/login' } }, explorer));

  deps = { decider, grounding, llm, trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: ['browse'], config: project.config.engine };
  const none = { verdicts: new Map(), edits: { schema_version: 0 as const, overrides: {}, added: [] } };
  for (const { repo, graph } of graphs) sets[repo.role] = await buildFlows(graph, none, deps, liveFor(project, repo, graphs));
});
after(async () => {
  await site?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const names = (set: FlowSet, keep: (flow: FlowSet['flows'][number]) => boolean) => set.flows.filter(keep).map((flow) => flow.name).sort();

test('UI: a page and its visible elements confirm a flow, the gaps say why, and what source lacks is observed-only', { skip: browserSkip }, () => {
  const web = sets.web;
  assert.deepEqual(names(web, (flow) => flow.status === 'confirmed'), [
    'User can add to cart',
    'User can cancel order',
    'User can save profile',
    'User can sign in',
    'User can sign out',
    'User can view product details',
    'User can view the account orders page',
    'User can view the account page',
    'User can view the cart page',
    'User can view the home page',
    'User can view the login page',
    'User can view the products page',
  ]);
  assert.ok(web.flows.filter((flow) => flow.status === 'confirmed').every((flow) => flow.origin === 'both' && flow.confidence === 1));
  assert.deepEqual(names(web, (flow) => flow.tags.includes(NOT_OBSERVED)), ['User can view the docs pages']);
  const why = (name: string) => web.reasons[web.flows.find((flow) => flow.name === name)?.id ?? ''] ?? [];
  // Seen but never submitted: confirmed by the visible form, with the explorer's reason kept.
  assert.ok(why('User can cancel order').includes("the explorer saw it on /account/orders and didn't submit it: rated destructive (p=0.90)"));
  assert.ok(why('User can sign out').includes("the explorer saw it on / and didn't submit it: it would end the session"));
  assert.ok(why('User can view the docs pages').includes('not observed: no run saw /docs/[...slug]'));
  assert.deepEqual(names(web, (flow) => flow.status === 'observed-only'), ['User can close', 'User can log in', 'User can search', 'User can view the about page']);
  assert.ok(web.flows.filter((flow) => flow.status === 'observed-only').every((flow) => flow.origin === 'observed' && !flow.enabled));
  assert.deepEqual(web.roles, [{ guard: 'middleware', node: 'web:guard:middleware', covered: true }]);
});

test('API: answered calls confirm their most specific route; writes and unexplored roles are tagged', { skip: browserSkip }, () => {
  const api = sets.api;
  assert.deepEqual(names(api, (flow) => flow.status === 'confirmed'), ['GET /api/v1/orders', 'GET /api/v1/products', 'GET /api/v1/products/:id', 'GET /api/v1/users/me', 'GET /health']);
  assert.deepEqual(names(api, (flow) => flow.tags.includes(ROLE_NOT_EXPLORED)), ['GET /api/v1/admin/stats']);
  assert.deepEqual(names(api, (flow) => flow.tags.includes(NOT_OBSERVED)), [
    'DELETE /api/v1/orders/:orderId',
    'GET /api/v1/orders/:orderId',
    'GET /api/v1/users/:id',
    'PATCH /api/v1/users/:id',
    'POST /api/v1/orders',
    'POST /api/v1/users/login',
    'POST /api/v1/users/register',
  ]);
  assert.deepEqual(names(api, (flow) => flow.status === 'observed-only'), ['GET /api/cart', 'GET /api/orders', 'GET /api/products', 'GET /api/products/:id', 'GET /api/v1/reviews', 'POST /api/auth/login']);
  assert.deepEqual(api.roles, [
    { guard: 'requireAuth', node: 'api:guard:requireAuth', covered: true },
    { guard: "requireRole('admin')", node: "api:guard:requireRole('admin')", covered: false },
  ]);
});

test('a confirmed flow keeps its code evidence and gains what the run captured; observed evidence names its run', { skip: browserSkip }, () => {
  const flow = sets.web.flows.find((candidate) => candidate.name === 'User can add to cart');
  const kinds = flow?.steps.map((step) => step.evidence.map((evidence) => evidence.type).join('+'));
  assert.deepEqual(kinds, ['code+dom+screenshot', 'code+code+dom', 'code+network']);
  assert.ok(flow?.steps.flatMap((step) => step.evidence).every((evidence) => evidence.type === 'code' || /^explorer-[a-z0-9-]+#[sar]\d+/.test(evidence.ref)));
});

test("a gap tag is added on top of a person's own tags, so editing tags never hides it", { skip: browserSkip }, async () => {
  const docs = sets.web.flows.find((flow) => flow.name === 'User can view the docs pages');
  assert.ok(docs);
  const edits = { schema_version: 0 as const, overrides: { [docs.id]: { tags: ['smoke'], version: 2, edited: '2026-10-20T10:00:00.000Z' } }, added: [] };
  const again = await buildFlows(graphs[0].graph, { verdicts: new Map(), edits }, deps, liveFor(project, graphs[0].repo, graphs));
  assert.deepEqual(again.flows.find((flow) => flow.id === docs.id)?.tags, ['smoke', NOT_OBSERVED]);
});
