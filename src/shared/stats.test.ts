import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile } from './stats.ts';

const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

test('percentile uses nearest rank', () => {
  assert.equal(percentile(oneToHundred, 50), 50);
  assert.equal(percentile(oneToHundred, 95), 95);
  assert.equal(percentile(oneToHundred, 99), 99);
  assert.equal(percentile(oneToHundred, 100), 100);
  assert.equal(percentile([10, 20, 30], 50), 20);
  assert.equal(percentile([7], 95), 7);
});

test('percentile does not depend on input order and does not mutate it', () => {
  const shuffled = [30, 10, 20];
  assert.equal(percentile(shuffled, 100), 30);
  assert.deepEqual(shuffled, [30, 10, 20]);
});

test('percentile rejects empty input and out-of-range p', () => {
  assert.throws(() => percentile([], 50), RangeError);
  assert.throws(() => percentile([1], 0), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
  assert.throws(() => percentile([1], Number.NaN), RangeError);
});
