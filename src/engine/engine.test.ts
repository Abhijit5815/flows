import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import { UNKNOWN, type Decider } from '../decider/decider.ts';
import type { Graph } from '../graph/schema.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import type { LlmGateway, LlmRequest } from '../llm/gateway.ts';
import { ProviderError } from '../shared/errors.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { buildFlows, type EngineDeps, type HumanInput } from './engine.ts';
import type { Verdict } from './judge.ts';
import { OptionalLlm } from './llm.ts';
import { FlowSetSchema } from './store.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/apps/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-engine-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const project = tempProject(join(tmp, 'project'));
let graph: Graph | undefined;
async function nextBasic(): Promise<Graph> {
  if (graph === undefined) {
    graph = (await scanRepo(project, addRepo(project, join(fixtures, 'next-basic'), 'web').config.repos[0])).graph;
    assert.ok(graph);
  }
  return graph;
}

const none: HumanInput = { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } };

const answer = (label: string) => ({ label, prob: 1, all_probs: { [label]: 1 }, version: 'stub' });

// Stand-ins: a Decider that knows a few words, a grounding check that supports only what the login flow's name
// and description say, and an LLM that writes one good and one made-up name.
const decider: Decider = {
  async decide(task, text) {
    if (task === 'destructive-risk') return answer(/delete|cancel/i.test(text) ? 'destructive' : /^page:/.test(text) ? 'safe' : UNKNOWN);
    return answer(/login/.test(text) ? 'auth' : UNKNOWN);
  },
};
const SUPPORTED = ['Log in with email and password', 'A visitor submits the login form with an email and a password.'];
const grounding: Decider = {
  async decide(_task, input) {
    const ok = SUPPORTED.includes(JSON.parse(input).claim);
    return { label: ok ? 'supported' : 'unsupported', prob: 1, all_probs: { supported: ok ? 1 : 0, unsupported: ok ? 0 : 1 }, version: 'stub' };
  },
};
function fakeLlm(fail = false): LlmGateway & { calls: string[] } {
  return {
    model: 'fake',
    calls: [],
    async completeJson<T>(request: LlmRequest<T>): Promise<T> {
      this.calls.push(request.purpose);
      if (fail) throw new ProviderError('POST http://localhost:11434/v1/chat/completions failed: connection refused');
      const reply =
        request.purpose === 'flow-category'
          ? { category: 'browse' }
          : request.prompt.includes('LoginForm')
            ? { name: SUPPORTED[0], description: SUPPORTED[1] }
            : { name: 'Buy the whole shop', description: 'Pays for every product in the shop at once.' };
      return request.schema.parse(reply);
    },
  };
}

function deps(gateway: LlmGateway, offs: string[] = [], cache = join(tmp, `llm-${Math.random()}.json`)): EngineDeps & { trace: MemoryTraceSink } {
  return {
    decider,
    grounding,
    llm: new OptionalLlm(gateway, cache, (reason) => offs.push(reason)),
    trace: new MemoryTraceSink(),
    categories: categories(project.config),
    categoryLabels: ['auth', 'browse', 'create-edit', 'search', 'settings', 'admin'],
    config: project.config.engine,
  };
}

test('flows are judged, named only where the steps support the name, and every step is traced', async () => {
  const run = deps(fakeLlm());
  const set = FlowSetSchema.parse(await buildFlows(await nextBasic(), none, run));
  const login = set.flows.find((flow) => flow.id === 'ui-082b51bb');
  assert.deepEqual([login?.name, login?.description, login?.category], [SUPPORTED[0], SUPPORTED[1], 'auth']);
  const products = set.flows.find((flow) => flow.id === 'ui-e45ebcf5');
  assert.equal(products?.name, 'Open /products', 'a made-up LLM name is not used');
  assert.ok(set.reasons['ui-e45ebcf5'].some((reason) => reason.includes('"Buy the whole shop" is not supported')));
  assert.equal(products?.category, 'browse', 'an unknown category goes to the LLM');
  // Destructive (and unsure) flows are verified but held for review.
  const cancel = set.flows.find((flow) => flow.id === 'ui-2f589ec9');
  assert.deepEqual([cancel?.status, cancel?.destructive, cancel?.enabled], ['verified', 'yes', false]);
  assert.deepEqual([products?.status, products?.destructive, products?.enabled, products?.confidence], ['verified', 'no', true, 0.9]);
  const events = run.trace.events.flatMap((event) => (event.kind === 'verdict' ? [`${event.stage} ${event.subject}`] : []));
  for (const flow of set.flows) assert.ok(events.includes(`verifier ${flow.id}`) && events.includes(`judge ${flow.id}`), flow.id);
});

test('a second scan asks the LLM nothing: replies are kept by prompt', async () => {
  const cache = join(tmp, 'llm-kept.json');
  const first = fakeLlm();
  await buildFlows(await nextBasic(), none, deps(first, [], cache));
  assert.ok(first.calls.length > 0);
  const second = fakeLlm();
  await buildFlows(await nextBasic(), none, deps(second, [], cache));
  assert.deepEqual(second.calls, []);
});

test('with a shared answers file, a teammate on another model asks nothing and gets the same names', async () => {
  const answers = join(tmp, 'shared', 'answers.jsonl');
  const first = fakeLlm();
  const shared = (gateway: LlmGateway) => ({ ...deps(gateway), llm: new OptionalLlm(gateway, join(tmp, `llm-${Math.random()}.json`), () => {}, answers) });
  const mine = await buildFlows(await nextBasic(), none, shared(first));
  assert.ok(first.calls.length > 0);
  const theirs = { ...fakeLlm(), model: 'another' };
  const again = await buildFlows(await nextBasic(), none, shared(theirs));
  assert.deepEqual(theirs.calls, []);
  assert.deepEqual(again.flows.map((flow) => flow.name), mine.flows.map((flow) => flow.name));
});

test("a reviewer's wrong verdict rejects the flow, and flows that needed it as their Log-in step lose that step", async () => {
  const verdicts = new Map<string, Verdict>([['ui-082b51bb', 'wrong'], ['ui-e68b64da', 'correct']]);
  const set = await buildFlows(await nextBasic(), { ...none, verdicts }, deps(fakeLlm()));
  const status = (id: string) => set.flows.find((flow) => flow.id === id);
  assert.equal(status('ui-082b51bb')?.status, 'rejected');
  assert.deepEqual([status('ui-3cb127a8')?.status, status('ui-3cb127a8')?.steps.some((step) => step.kind === 'subflow')], ['unverified', false]);
  assert.deepEqual([status('ui-e68b64da')?.confidence, status('ui-e68b64da')?.enabled], [1, true]);
});

test('with the LLM down, the run goes on from source alone and says so once', async () => {
  const offs: string[] = [];
  const gateway = fakeLlm(true);
  const set = await buildFlows(await nextBasic(), none, deps(gateway, offs));
  assert.equal(offs.length, 1);
  assert.equal(gateway.calls.length, 1, 'no call after the first failure');
  assert.equal(set.flows.find((flow) => flow.id === 'ui-082b51bb')?.name, 'Submit LoginForm#form on /login (POST /api/auth/login)');
  assert.equal(set.flows.find((flow) => flow.id === 'ui-e45ebcf5')?.category, 'uncategorized');
});
