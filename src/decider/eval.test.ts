import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Decider } from './decider.ts';
import { drift, evaluateTask, expectedCalibrationError } from './eval.ts';
import type { Task } from './task.ts';

test('expected calibration error: the gap between confidence and accuracy, bin by bin', () => {
  assert.equal(expectedCalibrationError([]), 0);
  // Bin 0.8-1.0: confidence 0.9, accuracy 0.5 -> gap 0.4, half the items; bin 0.2-0.4: 0.3 vs 0 -> 0.3, half.
  assert.ok(Math.abs(expectedCalibrationError([{ prob: 0.9, right: true }, { prob: 0.9, right: false }, { prob: 0.3, right: false }, { prob: 0.3, right: false }]) - 0.35) < 1e-9);
});

test('a task report: coverage, accuracy on decided items, per-label precision and recall, misses', async () => {
  const task: Task = {
    task: 'toy',
    description: 'toy',
    labels: ['a', 'b'],
    rules: [],
    examples: { a: ['x'], b: ['y'] },
    // Odd positions are the held-out half: a1, b1, a2, b2.
    labelled: [{ text: 'c0', label: 'a' }, { text: 'a1', label: 'a' }, { text: 'c1', label: 'b' }, { text: 'b1', label: 'b' }, { text: 'c2', label: 'a' }, { text: 'a2', label: 'a' }, { text: 'c3', label: 'b' }, { text: 'b2', label: 'b' }],
  };
  const answers: Record<string, [string, number]> = { a1: ['a', 0.9], b1: ['a', 0.8], a2: ['unknown', 0.5], b2: ['b', 0.95] };
  const decider: Decider = { decide: async (_task, text) => ({ label: answers[text][0], prob: answers[text][1], all_probs: { a: answers[text][0] === 'b' ? 0.05 : answers[text][1], b: answers[text][0] === 'b' ? 0.95 : 1 - answers[text][1] }, version: 'stub' }) };
  const report = await evaluateTask(decider, task);
  assert.deepEqual([report.heldOut, report.decided, report.right, report.coverage, report.accuracy], [4, 3, 2, 0.75, 2 / 3]);
  assert.deepEqual(report.labels, [
    { label: 'a', precision: 0.5, recall: 0.5 },
    { label: 'b', precision: 1, recall: 0.5 },
  ]);
  assert.deepEqual(report.misses.map((miss) => [miss.text, miss.got]), [['b1', 'a'], ['a2', 'unknown']]);
});

test('drift: overrides of what the current Decider decided; under ten, too few to tell', () => {
  const decisions = new Map(Array.from({ length: 40 }, (_, i) => [`t${i}`, 'browse'] as const));
  const learned = { settings: Array.from({ length: 12 }, (_, i) => `t${i}`), browse: ['t30'], admin: ['never decided'] };
  assert.deepEqual(drift('flow-category', decisions, learned, 0.2), { task: 'flow-category', decided: 40, overridden: 12, rate: 0.3, warn: true });
  assert.deepEqual(drift('flow-category', decisions, { settings: ['t1', 't2'] }, 0.2), { task: 'flow-category', decided: 40, overridden: 2, rate: null, warn: false });
});
