import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { evaluate, loadKeys, score } from './eval.ts';

const keys = fileURLToPath(new URL('../../ground-truth/', import.meta.url));
const samples = fileURLToPath(new URL('../../fixtures/samples/', import.meta.url));

test('score: recall, precision, and every miss and extra', () => {
  assert.deepEqual(score(['GET /a', 'POST /a', 'GET /b'], ['GET /a', 'GET /b', 'GET /c']), {
    expected: 3, found: 3, matched: 2, recall: 2 / 3, precision: 2 / 3, missed: ['POST /a'], extra: ['GET /c'],
  });
  assert.deepEqual(score([], []).recall, 1);
});

// PLAN.md Phase 2 exit, kept as a regression check: every sample app against its hand-written answer key.
for (const key of loadKeys(keys)) {
  test(`exit: ${key.app} against its answer key`, async (t) => {
    const result = await evaluate(key, join(samples, key.app));
    for (const [what, found] of [['endpoints', result.endpoints], ['pages', result.pages]] as const) {
      if (found === undefined) continue;
      t.diagnostic(`${what}: ${found.matched}/${found.expected} found, recall ${(found.recall * 100).toFixed(0)}%, precision ${(found.precision * 100).toFixed(0)}%`);
      assert.deepEqual({ missed: found.missed, extra: found.extra }, { missed: [], extra: [] }, `${key.app} ${what}`);
    }
  });
}
