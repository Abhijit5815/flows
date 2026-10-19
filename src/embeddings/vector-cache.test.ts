import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingProvider } from './provider.ts';
import { cachedVectors } from './vector-cache.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-vectors-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Deterministic stand-in: a text's vector is [length, 1], and every call is counted.
function countingProvider(version: string): EmbeddingProvider & { calls: number } {
  return {
    version,
    calls: 0,
    async embed(texts) {
      this.calls++;
      return texts.map((text) => Float32Array.from([text.length, 1]));
    },
  };
}

test('vectors are reused while the model and texts stay the same', async () => {
  const file = join(tmp, 'same.json');
  const provider = countingProvider('m1');
  const first = await cachedVectors(file, ['ab', 'abc'], provider);
  const second = await cachedVectors(file, ['ab', 'abc'], provider);
  assert.equal(provider.calls, 1);
  assert.deepEqual(second, first);
  assert.ok(second[0] instanceof Float32Array);
});

test('changing the texts or swapping the model rebuilds the vectors', async () => {
  const file = join(tmp, 'change.json');
  const provider = countingProvider('m1');
  await cachedVectors(file, ['a'], provider);
  await cachedVectors(file, ['a', 'b'], provider);
  assert.equal(provider.calls, 2);
  const swapped = countingProvider('m2');
  await cachedVectors(file, ['a', 'b'], swapped);
  assert.equal(swapped.calls, 1);
});

test('a damaged cache file is rebuilt', async () => {
  const file = join(tmp, 'damaged.json');
  writeFileSync(file, '{ not json');
  const provider = countingProvider('m1');
  assert.deepEqual(await cachedVectors(file, ['abcd'], provider), [Float32Array.from([4, 1])]);
  assert.equal(provider.calls, 1);
});
