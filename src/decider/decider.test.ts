import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THRESHOLD } from '../config/project.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { DeciderError } from '../shared/errors.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { DeciderV1, UNKNOWN } from './decider.ts';
import type { Task } from './task.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-decider-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Stand-in embedder: one dimension per keyword plus a constant, so similarity follows shared words.
const KEYWORDS = ['remove', 'pay', 'send', 'view', 'list', 'search'];
function keywordProvider(version: string): EmbeddingProvider & { calls: number } {
  return {
    version,
    calls: 0,
    async embed(texts) {
      this.calls++;
      return texts.map((text) => {
        const vector = Float32Array.from([...KEYWORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.2]);
        const norm = Math.hypot(...vector);
        return vector.map((value) => value / norm);
      });
    },
  };
}

const task: Task = {
  task: 'risk',
  description: 'test task',
  labels: ['destructive', 'safe', 'other'],
  rules: [{ pattern: '^DELETE\\s', flags: 'i', label: 'destructive' }],
  examples: { destructive: ['remove item', 'pay invoice', 'send email'], safe: ['view page', 'list items', 'search users'], other: ['search and view'] },
  labelled: [
    { text: 'remove user', label: 'destructive' },
    { text: 'view report', label: 'safe' },
    { text: 'pay bill', label: 'destructive' },
    { text: 'list orders', label: 'safe' },
    { text: 'send invite', label: 'destructive' },
    { text: 'search orders', label: 'safe' },
  ],
};

function decider(provider: EmbeddingProvider, cacheDir = join(tmp, provider.version)) {
  const trace = new MemoryTraceSink();
  return { trace, decider: new DeciderV1({ tasks: [task], provider, trace, cacheDir, threshold: () => DEFAULT_THRESHOLD }) };
}

test('a matching rule decides with probability 1, without embedding the input', async () => {
  const provider = keywordProvider('fake:a');
  const { decider: d, trace } = decider(provider);
  const decision = await d.decide('risk', 'DELETE /api/users/:id', ['destructive', 'safe']);
  assert.equal(decision.label, 'destructive');
  assert.equal(decision.prob, 1);
  const callsAfterPrepare = provider.calls;
  await d.decide('risk', 'DELETE /api/items/:id', ['destructive', 'safe']);
  assert.equal(provider.calls, callsAfterPrepare);
  assert.ok(trace.events.every((event) => event.kind === 'decision' && event.source === 'rule'));
});

test('the classifier picks the nearest label with calibrated probabilities that sum to one', async () => {
  const { decider: d } = decider(keywordProvider('fake:b'));
  const decision = await d.decide('risk', 'pay the supplier', ['destructive', 'safe']);
  assert.equal(decision.label, 'destructive');
  assert.ok(decision.prob >= DEFAULT_THRESHOLD.min_prob);
  assert.ok(Math.abs(Object.values(decision.all_probs).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('an input that matches no label better than another is unknown, not a guess', async () => {
  const { decider: d } = decider(keywordProvider('fake:c'));
  const decision = await d.decide('risk', 'zzz', ['destructive', 'safe']);
  assert.equal(decision.label, UNKNOWN);
  assert.ok(decision.prob < DEFAULT_THRESHOLD.min_prob || Math.abs(decision.all_probs.destructive - decision.all_probs.safe) < DEFAULT_THRESHOLD.min_margin);
});

test('only allowed labels are scored or returned', async () => {
  const { decider: d } = decider(keywordProvider('fake:d'));
  const decision = await d.decide('risk', 'search and view the list', ['destructive', 'safe']);
  assert.deepEqual(Object.keys(decision.all_probs).sort(), ['destructive', 'safe']);
  assert.notEqual(decision.label, 'other');
});

test('unknown types and bad label lists are DeciderErrors', async () => {
  const { decider: d } = decider(keywordProvider('fake:e'));
  await assert.rejects(d.decide('nope', 'x', ['a', 'b']), DeciderError);
  await assert.rejects(d.decide('risk', 'x', ['destructive', 'gone']), DeciderError);
  await assert.rejects(d.decide('risk', 'x', ['destructive']), DeciderError);
});

test('every decision writes exactly one trace event with the input, probs, threshold and version', async () => {
  const { decider: d, trace } = decider(keywordProvider('fake:f'));
  const inputs = ['remove the file', 'view the page', 'DELETE /x', 'zzz'];
  for (const input of inputs) await d.decide('risk', input, ['destructive', 'safe']);
  assert.equal(trace.events.length, inputs.length);
  trace.events.forEach((event, i) => {
    assert.ok(event.kind === 'decision');
    assert.equal(event.input, inputs[i]);
    assert.deepEqual(event.threshold, DEFAULT_THRESHOLD);
    assert.match(event.model_version, /^decider-v1\|fake:f\|task:[0-9a-f]{12}\|T=/);
  });
});

test('swapping the embedding model rebuilds the cached vectors and refits calibration', async () => {
  const cacheDir = join(tmp, 'shared-cache');
  const first = keywordProvider('fake:model-1');
  const before = await decider(first, cacheDir).decider.decide('risk', 'remove it', ['destructive', 'safe']);
  assert.ok(existsSync(join(cacheDir, 'risk.examples.json')) && existsSync(join(cacheDir, 'risk.calibration.json')));

  const again = keywordProvider('fake:model-1');
  await decider(again, cacheDir).decider.decide('risk', 'remove it', ['destructive', 'safe']);
  assert.equal(again.calls, 1, 'same model: only the input is embedded, vectors and calibration come from the cache');

  const swapped = keywordProvider('fake:model-2');
  const after = await decider(swapped, cacheDir).decider.decide('risk', 'remove it', ['destructive', 'safe']);
  assert.equal(swapped.calls, 3, 'new model: examples, calibration set and input are embedded again');
  assert.notEqual(after.version, before.version);
  assert.match(after.version, /fake:model-2/);
});
