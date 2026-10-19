// Real model download and inference; run with FLOWS_LIVE_TESTS=1. Weights go to the gitignored .cache/flows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveModelsDir as modelsDir, liveSkip as skip } from '../shared/testing/live.ts';
import { catalogueEntry } from './catalogue.ts';
import { LocalEmbeddingProvider } from './local.ts';

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i], 0);

test('live: bge-small-en-v1.5 is checksummed on download and embeds in-process', { skip }, async (t) => {
  const provider = new LocalEmbeddingProvider(catalogueEntry('bge-small-en-v1.5'), modelsDir);
  const [deleteAccount, removeUser, browse] = await provider.embed(['Delete my account', 'Remove the user account', 'Browse the product list']);
  for (const vector of [deleteAccount, removeUser, browse]) {
    assert.equal(vector.length, 384);
    assert.ok(Math.abs(dot(vector, vector) - 1) < 1e-4, 'unit length');
  }
  const near = dot(deleteAccount, removeUser);
  const far = dot(deleteAccount, browse);
  t.diagnostic(`cosine(delete account, remove user) = ${near.toFixed(3)}; cosine(delete account, browse products) = ${far.toFixed(3)}`);
  assert.ok(near > far);
});
