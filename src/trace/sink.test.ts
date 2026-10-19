import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowsError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { eventBase, type TraceEvent } from './event.ts';
import { JsonlTraceSink, MemoryTraceSink, readTrace } from './sink.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-trace-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const decision = (input: string): TraceEvent => ({
  ...eventBase(performance.now()),
  kind: 'decision',
  decision_type: 'destructive-risk',
  input,
  inputs_ref: sha256(input),
  allowed_labels: ['destructive', 'safe'],
  label: 'destructive',
  source: 'rule',
  probs: { destructive: 1 },
  threshold: { min_prob: 0.7, min_margin: 0.1 },
  model_version: 'decider-v1|test',
});

const llmCall: TraceEvent = {
  ...eventBase(performance.now()),
  kind: 'llm_call',
  purpose: 'name-flow',
  model_version: 'anthropic:claude-opus-5-5',
  llm_call: { provider: 'anthropic', model: 'claude-opus-5-5', system: 's', prompt: 'p', output: '{}', ok: true },
  tokens: { input: 10, output: 3 },
};

test('the JSONL sink appends events and readTrace returns them in order', () => {
  const file = join(tmp, 'a', 'trace.jsonl');
  const sink = new JsonlTraceSink(file);
  sink.record(decision('button: Delete account'));
  sink.record(llmCall);
  const events = readTrace(file);
  assert.deepEqual(events.map((event) => event.kind), ['decision', 'llm_call']);
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('an invalid event is rejected and nothing is written', () => {
  const file = join(tmp, 'b', 'trace.jsonl');
  const sink = new JsonlTraceSink(file);
  const bad = { ...decision('x'), inputs_ref: 'not-a-hash' };
  assert.throws(() => sink.record(bad), FlowsError);
  assert.deepEqual(readTrace(file), []);
  assert.throws(() => new MemoryTraceSink().record(bad), FlowsError);
});

test('a damaged line names the file and line number', () => {
  const file = join(tmp, 'c', 'trace.jsonl');
  new JsonlTraceSink(file).record(llmCall);
  appendFileSync(file, '{ broken\n');
  assert.throws(() => readTrace(file), (error: unknown) => error instanceof FlowsError && error.message.includes(':2 is not valid JSON'));
});

test('a missing trace file reads as empty', () => {
  assert.deepEqual(readTrace(join(tmp, 'nothing.jsonl')), []);
});
