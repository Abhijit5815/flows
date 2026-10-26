// PLAN.md Phase 5: a person's edits survive every rescan, their own steps are reported on but never dropped, and
// their verdicts stand.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import type { Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import type { Flow } from '../model/flow.ts';
import { addRule, loadRules, now, rulesFile } from '../rules/learned.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { runClaim } from './describe.ts';
import { editsFile, loadEdits, saveAdded, saveOverride } from './edits.ts';
import { refreshFlows, verdictsOf, type EngineDeps } from './engine.ts';
import { OptionalLlm } from './llm.ts';
import type { FlowSet } from './store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-edits-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Each test edits its own copy of the fixture, since edits are saved inside the repo.
async function setup(name: string) {
  const dir = join(tmp, name);
  cpSync(fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), dir, { recursive: true });
  const project = addRepo(tempProject(join(tmp, `${name}-project`)), dir, 'web');
  const repo = project.config.repos[0];
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  const answer = (label: string) => ({ label, prob: 1, all_probs: { [label]: 1 }, version: 'stub' });
  const deps: EngineDeps = {
    decider: { decide: async (task) => answer(task === 'destructive-risk' ? 'safe' : 'unknown') },
    grounding: { decide: async () => answer('unsupported') } satisfies Decider,
    llm: new OptionalLlm(undefined, join(tmp, `${name}-llm.json`), () => {}),
    trace: new MemoryTraceSink(),
    categories: categories(project.config),
    categoryLabels: [],
    config: project.config.engine,
  };
  const scan = () => refreshFlows(project, repo, graph as Graph, deps);
  return { dir, scan, first: await scan() };
}

const flowIn = (set: FlowSet, id: string): Flow => {
  const found = set.flows.find((flow) => flow.id === id);
  assert.ok(found, `no flow ${id}`);
  return found;
};

test("a person's fields survive the next scan and win over what the scan decides", async () => {
  const { dir, scan, first } = await setup('fields');
  const products = flowIn(first, 'ui-e45ebcf5');
  saveOverride(dir, products.id, { name: 'Browse the shop', category: 'browse', enabled: false, disabled_steps: ['s2'] }, products.version);
  const again = flowIn(await scan(), products.id);
  assert.deepEqual([again.name, again.category, again.enabled, again.version], ['Browse the shop', 'browse', false, 2]);
  assert.deepEqual(again.steps.map((step) => step.enabled), [true, false]);
  saveOverride(dir, products.id, { enabled: true }, again.version);
  assert.deepEqual([flowIn(await scan(), products.id).name, flowIn(await scan(), products.id).version], ['Browse the shop', 3], 'later edits keep earlier fields');
});

test("a person's own steps are kept even where source doesn't back them, and the reasons say so", async () => {
  const { dir, scan, first } = await setup('steps');
  const cart = flowIn(first, 'ui-3cb127a8');
  const made = { id: 's9', kind: 'api' as const, claim: 'Calls POST /api/cart/checkout', request: { method: 'POST' as const, path: '/api/cart/checkout' }, evidence: [{ type: 'code' as const, node_id: 'web:api-call:POST /api/cart/checkout', ref: 'lib/api.ts:30' }], check: null, enabled: true };
  saveOverride(dir, cart.id, { steps: [...cart.steps, made] }, cart.version);
  const set = await scan();
  const again = flowIn(set, cart.id);
  assert.deepEqual(again.steps.map((step) => step.id), [...cart.steps.map((step) => step.id), 's9']);
  assert.equal(again.status, 'unverified');
  assert.ok(set.reasons[cart.id].some((reason) => reason.startsWith('s9 is not backed by source')));
});

test('an added flow keeps its own name, and its subflow step may run any flow of its kind', async () => {
  const { dir, scan, first } = await setup('added');
  const login = flowIn(first, 'ui-082b51bb');
  const view = flowIn(first, 'ui-e45ebcf5');
  const added: Flow = {
    ...structuredClone(view),
    id: 'ui-added-1',
    name: 'Look around the shop after logging in',
    steps: [{ id: 's1', kind: 'subflow', claim: runClaim(login.name), subflow_ref: login.id, evidence: structuredClone(login.steps[0].evidence), check: null, enabled: true }, ...structuredClone(view.steps).map((step, i) => ({ ...step, id: `s${i + 2}` }))],
  };
  saveAdded(dir, added);
  const again = flowIn(await scan(), 'ui-added-1');
  assert.deepEqual([again.name, again.status, again.steps[0].subflow_ref], ['Look around the shop after logging in', 'verified', login.id]);
  assert.equal(loadEdits(dir).added.length, 1);
});

test('a "never" verdict rejects the flow at every scan', async () => {
  const { dir, scan } = await setup('never');
  addRule(dir, { type: 'feedback', flow: 'ui-e68b64da', kind: 'never', added: now() });
  const set = await scan();
  assert.deepEqual([flowIn(set, 'ui-e68b64da').status, flowIn(set, 'ui-e68b64da').enabled], ['rejected', false]);
  assert.ok(set.reasons['ui-e68b64da'].includes('a reviewer said never to suggest it again'));
});

// Two people review on their own branches; git's union merge keeps both sides' lines, ours first, whatever their times.
test('after a union merge, both people\'s edits to one flow stay and the later one wins a field both set', () => {
  const dir = join(tmp, 'merged');
  mkdirSync(dir);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const base = line({ type: 'override', id: 'ui-1', patch: { name: 'Base' }, version: 2, edited: '2026-10-26T09:00:00.000Z' });
  const alice = line({ type: 'override', id: 'ui-1', patch: { name: 'Alice', priority: 'high' }, version: 3, edited: '2026-10-26T10:00:00.000Z' });
  const bob = line({ type: 'override', id: 'ui-1', patch: { name: 'Bob', tags: ['smoke'] }, version: 3, edited: '2026-10-26T11:00:00.000Z' });
  mkdirSync(join(dir, '.flows'));
  writeFileSync(editsFile(dir), base + bob + alice);
  const { name, priority, tags, version } = loadEdits(dir).overrides['ui-1'];
  assert.deepEqual({ name, priority, tags, version }, { name: 'Bob', priority: 'high', tags: ['smoke'], version: 3 });
  assert.equal(saveOverride(dir, 'ui-1', { enabled: false }, 3).version, 4);

  const verdict = (kind: string, added: string) => line({ type: 'feedback', flow: 'ui-1', kind, added });
  writeFileSync(rulesFile(dir), verdict('wrong', '2026-10-26T11:00:00.000Z') + verdict('correct', '2026-10-26T10:00:00.000Z'));
  assert.equal(verdictsOf(loadRules(dir)).get('ui-1'), 'wrong', 'the later verdict wins');
  addRule(dir, { type: 'exclude', node: 'api:route:GET /health', added: now() });
  assert.equal(readFileSync(join(dir, '.flows', '.gitattributes'), 'utf8'), '*.jsonl merge=union\n');
});
