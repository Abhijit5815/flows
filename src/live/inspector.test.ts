import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { JWT_CANARY, startLiveFixture, type LiveFixture } from '../../fixtures/live/server.ts';
import { addRepo, categories, type Project, type Repo } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { buildFlows, type EngineDeps } from '../engine/engine.ts';
import { OptionalLlm } from '../engine/llm.ts';
import { saveFlows, type FlowSet } from '../engine/store.ts';
import type { Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { loadRules } from '../rules/learned.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { liveFor } from './crosscheck.ts';
import { inspect, type InspectInput } from './inspector.ts';
import { guidedSteps, knowing } from './know.ts';
import { indexOf } from './match.ts';
import { runDir, saveRun } from './run.ts';

const options = { email: 'shopper@example.com', password: randomBytes(9).toString('hex'), secret: `tok_${randomBytes(16).toString('hex')}` };
const tmp = mkdtempSync(join(tmpdir(), 'flows-inspector-'));
// The correction lands in the repo's .flows/, so the walk works on a copy of the fixture.
const fixture = join(tmp, 'next-basic');
cpSync(fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), fixture, { recursive: true });
let site: LiveFixture;
let project: Project;
let repo: Repo;
let graph: Graph;
let set: FlowSet;
let storageState: string;

const answer = (label: string) => ({ label, prob: 0.95, all_probs: { [label]: 0.95 }, version: 'stub' });
const decider: Decider = { decide: async (task) => answer(task === 'event-noise' ? 'relevant' : task === 'flow-category' ? 'browse' : 'safe') };
const deps = (): EngineDeps => ({ decider, grounding: { decide: async () => answer('unsupported') }, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => undefined), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: ['browse'], config: project.config.engine });

before(async () => {
  if (browserSkip !== false) return;
  site = await startLiveFixture(options);
  project = addRepo(tempProject(join(tmp, 'project')), fixture, 'web');
  repo = project.config.repos[0];
  const scanned = await scanRepo(project, repo);
  assert.ok(scanned.graph);
  graph = scanned.graph;
  set = await buildFlows(graph, { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } }, deps());
  saveFlows(project, repo, set);
  // Signed in, as a person who logged in before opening the inspector.
  storageState = join(tmp, 'state.json');
  writeFileSync(storageState, JSON.stringify({ cookies: [{ name: 'session', value: site.session(), domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
});
after(async () => {
  await site?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const walk = (person: (page: Page) => Promise<void>, guided?: InspectInput['guided']) =>
  inspect(
    { url: site.url, session: 'tester', storageState, guided, headless: true, person },
    { decider, config: project.config.explorer, pages: graph.nodes.flatMap((node) => (node.kind === 'page' ? [node.attrs.path] : [])), knowing: knowing(project, [{ repo, graph }]), runDir: (id) => runDir(project, id), log: () => undefined },
  );

const tip = (page: Page) => page.locator('flows-inspector .what');
const settle = (page: Page) => page.waitForTimeout(700);

test('free mode: pointing shows what source knows, the person writes for real, and a correction becomes a match rule', { skip: browserSkip }, async () => {
  const before = site.writes.length;
  const { run } = await walk(async (page) => {
    await settle(page); // a person looks at the start page before moving on
    await page.goto(`${site.url}/products`);
    await page.getByTestId('add-1').hover();
    await settle(page);
    assert.equal(await tip(page).textContent(), 'In source: AddToCartButton#onClick · components/AddToCartButton.tsx:6');
    await page.getByTestId('add-1').click();
    await settle(page);
    // "It is none of these": the person says this button is no source node.
    await page.locator('flows-inspector .pick').selectOption('');
    await page.locator('flows-inspector .save').click();
    await settle(page);
    assert.equal(await tip(page).textContent(), 'Not in source (on /products)');
    await page.goto(`${site.url}/account`);
    await page.locator('#profile input[name=name]').hover();
    await settle(page);
    assert.equal(await tip(page).textContent(), 'In source: ProfileForm#form · components/ProfileForm.tsx:15');
    await page.locator('flows-inspector .done').click();
  });
  assert.equal(run.kind, 'inspector');
  assert.deepEqual(site.writes.slice(before).filter((write) => !write.endsWith('/api/track')), ['POST /api/cart/items'], "the person's own click reached the app: the inspector blocks nothing");
  assert.ok(run.actions.some((action) => action.kind === 'click' && action.element.selector === 'testid:add-1'), 'the click was recorded');
  assert.deepEqual(new Set(run.states.map((state) => state.path)), new Set(['/', '/products', '/account']));
  assert.deepEqual(
    loadRules(fixture).flatMap((rule) => (rule.type === 'match' ? [[rule.page, rule.selector, rule.node]] : [])),
    [['/products', 'testid:add-1', null]],
  );
  const kept = JSON.stringify(run);
  for (const canary of [options.email, options.secret, JWT_CANARY]) assert.ok(!kept.includes(canary), 'the capture is redacted like the explorer\'s');

  // The cross-check uses the correction: that click is no longer the source's add-to-cart, so it shows as observed-only.
  saveRun(project, run);
  const after = await buildFlows(graph, { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } }, deps(), liveFor(project, repo, [{ repo, graph }]));
  assert.ok(after.flows.some((flow) => flow.status === 'observed-only' && flow.name === 'Click "Add to cart" on /products'));
});

test('guided mode: each step of the flow is ticked as the person does it', { skip: browserSkip }, async () => {
  const flow = set.flows.find((candidate) => candidate.name === 'Open /products');
  assert.ok(flow);
  const steps = guidedSteps(flow, indexOf(graph));
  const { run, ticked } = await walk(
    async (page) => {
      await page.goto(`${site.url}/products`);
      // The overlay asks for the ticks every 0.8 s; wait until it shows them all.
      await page.locator('flows-inspector li.done').nth(steps.length - 1).waitFor({ timeout: 5000 });
      assert.equal(await page.locator('flows-inspector li.done').count(), steps.length, 'the overlay shows every step ticked');
    },
    { flow: flow.id, steps },
  );
  assert.deepEqual(ticked, steps.map((step) => step.id));
  assert.equal(run.flow, flow.id);
});
