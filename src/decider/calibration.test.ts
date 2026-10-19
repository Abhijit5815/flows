import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeciderError } from '../shared/errors.ts';
import { fitTemperature, softmax, type CalibrationItem } from './calibration.ts';

// Small seeded generator so the synthetic data is the same on every run.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('softmax sums to one and ignores a constant shift', () => {
  const probs = softmax([0.9, 0.5, 0.1], 0.1);
  assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(softmax([10.9, 10.5, 10.1], 0.1).map((p) => p.toFixed(10)), probs.map((p) => p.toFixed(10)));
  assert.ok(probs[0] > probs[1] && probs[1] > probs[2]);
});

test('fitTemperature recovers the temperature that generated the labels', () => {
  const random = mulberry32(42);
  const trueTemperature = 0.05;
  const items: CalibrationItem[] = Array.from({ length: 4000 }, () => {
    const scores = [random(), random(), random()].map((value) => 0.3 + 0.4 * value);
    const probs = softmax(scores, trueTemperature);
    const draw = random();
    const label = draw < probs[0] ? 0 : draw < probs[0] + probs[1] ? 1 : 2;
    return { scores, label };
  });
  const fitted = fitTemperature(items);
  assert.ok(Math.abs(fitted - trueTemperature) / trueTemperature < 0.15, `fitted ${fitted}`);
});

test('fitTemperature refuses an empty calibration set', () => {
  assert.throws(() => fitTemperature([]), DeciderError);
});
