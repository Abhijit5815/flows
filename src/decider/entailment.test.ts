// PLAN.md §7 claim-vs-evidence grounding. The live test needs the real model (downloaded once into .cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLD } from '../config/project.ts';
import { DeciderError } from '../shared/errors.ts';
import { percentile } from '../shared/stats.ts';
import { liveModelsDir, liveSkip } from '../shared/testing/live.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { UNKNOWN } from './decider.ts';
import { EntailmentDecider, GROUNDING, GROUNDING_LABELS, groundingInput } from './entailment.ts';

const labels = [...GROUNDING_LABELS];

test('a malformed grounding question is refused before any model is loaded', async () => {
  // A models folder that does not exist: reaching the model would try to download it.
  const decider = new EntailmentDecider({ modelsDir: '/nonexistent/models', trace: new MemoryTraceSink(), threshold: DEFAULT_THRESHOLD });
  await assert.rejects(decider.decide('destructive-risk', groundingInput('a', 'b'), labels), DeciderError);
  await assert.rejects(decider.decide(GROUNDING, groundingInput('a', 'b'), ['supported', 'safe']), DeciderError);
  await assert.rejects(decider.decide(GROUNDING, 'not json', labels), DeciderError);
  await assert.rejects(decider.decide(GROUNDING, JSON.stringify({ evidence: 'a' }), labels), DeciderError);
});

const EVIDENCE = 'Open /login. Fill in and submit LoginForm#form (email, password), which runs authenticate.';

test('live: grounding tells supported claims from made-up ones, under 100 ms at p95', { skip: liveSkip }, async (t) => {
  const trace = new MemoryTraceSink();
  const decider = new EntailmentDecider({ modelsDir: liveModelsDir, trace, threshold: DEFAULT_THRESHOLD });
  const ask = async (claim: string, evidence = EVIDENCE) => {
    const decision = await decider.decide(GROUNDING, groundingInput(evidence, claim), labels);
    t.diagnostic(`${decision.label.padEnd(11)} p(supported)=${decision.all_probs.supported.toFixed(3)}  "${claim}"`);
    return decision.label;
  };
  assert.equal(await ask('Fill in and submit the login form with an email and a password'), 'supported');
  assert.equal(await ask('Delete every order in the database'), 'unsupported');
  assert.equal(await ask('Pay for the order with a saved card'), 'unsupported');
  assert.equal(await ask('Call DELETE /api/v1/users/:id', 'Call GET /api/v1/users/:id (handled by getById).'), 'unsupported');
  // Names an LLM might write: printed for the record, not asserted (PLAN.md Phase 4 risk: premises come from code).
  for (const name of ['Log in with email and password', 'Sign in to the dashboard', 'Reset a forgotten password']) {
    const label = await ask(name);
    assert.ok([...labels, UNKNOWN].includes(label));
  }
  assert.ok(trace.events.every((event) => event.kind === 'decision' && event.source === 'entailment'));

  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await decider.decide(GROUNDING, groundingInput(EVIDENCE, i % 2 === 0 ? 'Submit the login form' : 'Delete the account'), labels);
    times.push(performance.now() - start);
  }
  const p95 = percentile(times, 95);
  t.diagnostic(`latency: p50 ${percentile(times, 50).toFixed(1)} ms | p95 ${p95.toFixed(1)} ms | max ${percentile(times, 100).toFixed(1)} ms`);
  assert.ok(p95 < 100, `p95 ${p95.toFixed(1)} ms`);
});
