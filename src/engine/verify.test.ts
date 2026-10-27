import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, DEFAULT_THRESHOLD } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { EntailmentDecider } from '../decider/entailment.ts';
import { lookup } from '../graph/lookup.ts';
import type { Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import type { Flow } from '../model/flow.ts';
import { liveModelsDir, liveSkip } from '../shared/testing/live.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { candidates } from './candidates.ts';
import { judge } from './judge.ts';
import { API_FAKES, UI_FAKES, type Fake, type Kit } from './planted.ts';
import { reachability, unreachableBecause } from './reach.ts';
import { addLoginSubflows } from './subflows.ts';
import { verifyFlows, type VerifyContext } from './verify.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/apps/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-verify-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Fixture = { graph: Graph; genuine: Flow[] };
const scanned = new Map<string, Promise<Fixture>>();
function fixture(app: string, role: 'web' | 'api'): Promise<Fixture> {
  if (!scanned.has(app)) {
    scanned.set(app, (async () => {
      const project = tempProject(join(tmp, app));
      const { graph } = await scanRepo(project, addRepo(project, join(fixtures, app), role).config.repos[0]);
      assert.ok(graph);
      return { graph, genuine: addLoginSubflows(candidates(graph).flows, lookup(graph)).flows };
    })());
  }
  return scanned.get(app) as Promise<Fixture>; // safe: set just above
}

// A grounding Decider that supports nothing, and counts how often it is asked.
function refusing(): Decider & { asked: number } {
  return {
    asked: 0,
    async decide() {
      this.asked++;
      return { label: 'unsupported', prob: 1, all_probs: { supported: 0, unsupported: 1 }, version: 'refusing' };
    },
  };
}

function kitFor(flows: readonly Flow[]): Kit {
  let n = 0;
  const flow = (name: string) => {
    const found = flows.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no genuine flow named "${name}"`);
    return found;
  };
  return { flow, copy: (name) => ({ ...structuredClone(flow(name)), id: `fake-${++n}` }), context: [] };
}

// What the verifier, reachability and the judge make of these flows, by flow id (or "rejected" when nothing survived).
async function outcomes(inputs: readonly unknown[], { graph }: Fixture, grounding: Decider) {
  const nodes = lookup(graph);
  const context: VerifyContext = { graph, nodes, grounding, maxDepth: 3 };
  const reach = reachability(graph, nodes);
  return (await verifyFlows(inputs, context)).map((result) => {
    if (!result.ok) return { status: 'rejected', reasons: result.reasons };
    const { status, reasons } = judge({ claims: result.claims, proven: result.proven, unreachable: unreachableBecause(result.flow, reach), destructive: 'no', verdict: undefined, sourceOnlyWeight: 0.9 });
    return { status, reasons: [...result.reasons, ...reasons] };
  });
}

for (const [app, role] of [['express-basic', 'api'], ['next-basic', 'web']] as const) {
  test(`${app}: every generated flow is verified, without asking the grounding model`, async () => {
    const found = await fixture(app, role);
    const grounding = refusing();
    const results = await outcomes(found.genuine, found, grounding);
    assert.deepEqual(results.filter((result) => result.status !== 'verified'), []);
    assert.equal(grounding.asked, 0, 'template claims are proven by rule');
  });
}

// The negative cases are claims too: an error, a body field or a redirect source doesn't back is dropped, with why.
test('errors, a request body and a redirect check stay only when source backs them', async () => {
  const verify = async (flow: Flow, { graph }: Fixture) => {
    const [result] = await verifyFlows([flow], { graph, nodes: lookup(graph), grounding: refusing(), maxDepth: 3 });
    assert.ok(result.ok);
    return result;
  };
  const api = await fixture('express-basic', 'api');
  const register = structuredClone(api.genuine.find((flow) => flow.name === 'POST /api/v1/users/register') as Flow);
  const call = register.steps[0];
  assert.ok(call.errors !== undefined && call.request?.body !== undefined);
  const cited = call.errors[1].evidence;
  call.errors.push({ kind: 'api', status: 500, by: 'register', evidence: cited }, { kind: 'api', status: 409, by: 'register', message: 'try again later', evidence: cited });
  call.request.body.fields[1].rules = ['min(1)'];
  const kept = (await verify(register, api)).flow.steps[0];
  assert.deepEqual(kept.errors?.map((error) => (error.kind === 'api' ? `${error.status} ${error.message ?? ''}` : '')), ['400 ', '409 email already registered']);
  assert.deepEqual(kept.request, { method: 'POST', path: '/api/v1/users/register' });

  const web = await fixture('next-basic', 'web');
  const login = structuredClone(web.genuine.find((flow) => flow.id === 'ui-082b51bb') as Flow);
  const submit = login.steps[1];
  assert.ok(submit.check?.kind === 'ui' && submit.errors?.[0].kind === 'ui');
  submit.check.page = '/admin';
  submit.errors.push({ kind: 'ui', message: 'Welcome back!', evidence: submit.errors[0].evidence });
  assert.ok(submit.action?.button !== undefined);
  submit.action.button.text = 'Delete everything';
  const result = await verify(login, web);
  assert.deepEqual([result.flow.steps[1].check, result.flow.steps[1].errors?.length, result.flow.steps[1].action], [null, 2, undefined]);
  assert.ok(result.reasons.some((reason) => reason.includes('redirect to /admin')) && result.reasons.some((reason) => reason.includes('"Welcome back!"')));
  assert.ok(result.reasons.some((reason) => reason.includes('action dropped')), 'an action the form does not have is dropped');
});

// PLAN.md Phase 4 exit: zero fabricated routes or steps pass the verifier.
async function plant(fakes: readonly Fake[], found: Fixture, grounding: Decider, report: (line: string) => void): Promise<number> {
  let passed = 0;
  for (const fake of fakes) {
    const kit = kitFor(found.genuine);
    const planted = fake.make(kit);
    const results = (await outcomes([...found.genuine, ...kit.context, ...planted], found, grounding)).slice(found.genuine.length + kit.context.length);
    for (const result of results) {
      if (result.status === 'verified') passed++;
      report(`${result.status === 'verified' ? 'PASSED' : result.status.padEnd(11)}  ${fake.name}: ${result.reasons[0] ?? ''}`);
    }
  }
  return passed;
}

const SUITES = [['express-basic', 'api', API_FAKES], ['next-basic', 'web', UI_FAKES]] as const;

test('planted fakes: none passes the verifier (stand-in grounding model)', async (t) => {
  let planted = 0;
  let passed = 0;
  for (const [app, role, fakes] of SUITES) {
    passed += await plant(fakes, await fixture(app, role), refusing(), (line) => t.diagnostic(line));
    planted += fakes.length;
  }
  t.diagnostic(`${planted} planted, ${passed} passed`);
  assert.equal(passed, 0);
});

test('live: planted fakes, none passes the verifier with the real entailment model', { skip: liveSkip }, async (t) => {
  const grounding = new EntailmentDecider({ modelsDir: liveModelsDir, trace: new MemoryTraceSink(), threshold: DEFAULT_THRESHOLD });
  let planted = 0;
  let passed = 0;
  for (const [app, role, fakes] of SUITES) {
    passed += await plant(fakes, await fixture(app, role), grounding, (line) => t.diagnostic(line));
    planted += fakes.length;
  }
  t.diagnostic(`${planted} planted, ${passed} passed`);
  assert.equal(passed, 0);
});

test('the reasons name what was wrong: the subflow cycle and the nesting cap', async () => {
  const found = await fixture('express-basic', 'api');
  const reasons = async (name: string) => {
    const fake = API_FAKES.find((candidate) => candidate.name === name);
    assert.ok(fake);
    const kit = kitFor(found.genuine);
    const planted = fake.make(kit);
    return (await outcomes([...found.genuine, ...kit.context, ...planted], found, refusing())).slice(found.genuine.length + kit.context.length).flatMap((result) => result.reasons);
  };
  assert.ok((await reasons('two flows that run each other (a cycle)')).some((reason) => reason.includes('a cycle')));
  assert.ok((await reasons('subflows nested four deep')).some((reason) => reason.includes('nest 4 deep; the cap is 3')));
  assert.ok((await reasons('a subflow that does not log in')).some((reason) => reason.includes('is not a login flow')));
});
