import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costs, priceOf } from './cost.ts';
import type { TraceEvent } from './event.ts';

const call = (run: string | undefined, provider: string, model: string, tokens: { input: number; output: number } | null): TraceEvent => ({
  id: crypto.randomUUID(),
  at: '2026-10-21T09:00:00.000Z',
  duration_ms: 1,
  ...(run === undefined ? {} : { run }),
  kind: 'llm_call',
  purpose: 'flow-name',
  model_version: model,
  llm_call: { provider, model, system: '', prompt: '', output: '{}', ok: true },
  tokens,
});

test('tokens per run and model; a cost only where a price is known and every call was counted', () => {
  const events = [call('r1 scan', 'anthropic', 'claude-opus-5-5', { input: 1000, output: 200 }), call('r1 scan', 'anthropic', 'claude-opus-5-5', { input: 3000, output: 800 }), call('r2 scan', 'openai-compatible', 'other', null)];
  const priced = costs(events, () => ({ input: 5, output: 25 }));
  assert.deepEqual(priced.map((run) => [run.run, run.calls, run.cost]), [
    ['r1 scan', 2, (4000 * 5 + 1000 * 25) / 1e6],
    ['r2 scan', 1, null],
  ]);
  assert.deepEqual(priced[0].models[0], { model: 'anthropic/claude-opus-5-5', calls: 2, input: 4000, output: 1000, uncounted: 0, cost: 0.045 });
  assert.equal(costs(events, () => undefined)[0].cost, null, 'no price, no cost');
});

test('prices: from the config, free for a local model or the assistant, unknown otherwise', () => {
  const hosted = priceOf({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', price_per_mtok: { input: 5, output: 25 } });
  assert.deepEqual(hosted('anthropic/claude-opus-5-5'), { input: 5, output: 25 });
  assert.equal(hosted('anthropic/another-model'), undefined);
  assert.deepEqual(hosted('assistant/assistant'), { input: 0, output: 0 });
  const local = priceOf({ provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.2:3b', timeout_ms: 1000 });
  assert.deepEqual(local('openai-compatible/llama3.2:3b'), { input: 0, output: 0 });
  const remote = priceOf({ provider: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3', timeout_ms: 1000 });
  assert.equal(remote('openai-compatible/z-ai/glm-5.3'), undefined, 'a hosted model without a configured price');
});
