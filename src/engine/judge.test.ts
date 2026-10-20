import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, type JudgeInput } from './judge.ts';

const base: JudgeInput = { claims: 4, proven: 4, unreachable: undefined, destructive: 'no', verdict: undefined, sourceOnlyWeight: 0.9 };
const row = (change: Partial<JudgeInput>) => {
  const { status, confidence, enabled } = judge({ ...base, ...change });
  return { status, confidence, enabled };
};

test('status, confidence and enabled, from proof, reachability, destructiveness and the reviewer', () => {
  assert.deepEqual(row({}), { status: 'verified', confidence: 0.9, enabled: true });
  // Destructive (or unsure) flows are held for review whatever their confidence.
  assert.deepEqual(row({ destructive: 'yes' }), { status: 'verified', confidence: 0.9, enabled: false });
  assert.deepEqual(row({ destructive: 'unknown' }), { status: 'verified', confidence: 0.9, enabled: false });
  assert.deepEqual(row({ proven: 3 }), { status: 'unverified', confidence: 0.68, enabled: false });
  assert.deepEqual(row({ unreachable: 'it does not start at a page or a route' }), { status: 'unreachable', confidence: 0.9, enabled: false });
  assert.deepEqual(row({ verdict: 'wrong' }), { status: 'rejected', confidence: 0, enabled: false });
  assert.deepEqual(row({ verdict: 'correct', destructive: 'yes' }), { status: 'verified', confidence: 1, enabled: true });
  assert.deepEqual(row({ verdict: 'correct', unreachable: 'no entry' }), { status: 'unreachable', confidence: 1, enabled: false });
  assert.deepEqual(row({ sourceOnlyWeight: 1 }), { status: 'verified', confidence: 1, enabled: true });
});

test('the reasons say why a flow is held back', () => {
  assert.deepEqual(judge({ ...base, proven: 3, destructive: 'unknown' }).reasons, ['1 of 4 claims are not backed by source', 'held for review: destructive is unknown']);
});
