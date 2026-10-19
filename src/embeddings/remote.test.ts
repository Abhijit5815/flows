import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../shared/errors.ts';
import { replyJson, startFakeServer } from '../shared/testing/fake-server.ts';
import { RemoteEmbeddingProvider } from './remote.ts';

// Replies out of order on purpose; the model name picks a broken reply.
const server = await startFakeServer((request, response) => {
  const { model, input } = JSON.parse(request.body) as { model: string; input: string[] };
  if (model === 'too-few') return replyJson(response, 200, { data: [{ index: 0, embedding: [1, 0] }] });
  if (model === 'zero') return replyJson(response, 200, { data: input.map((_, index) => ({ index, embedding: [0, 0] })) });
  if (model === 'down') return replyJson(response, 503, { error: 'unavailable' });
  replyJson(response, 200, { data: input.map((_, index) => ({ index, embedding: [3 * (index + 1), 4 * (index + 1)] })).reverse() });
});
after(() => server.close());

const provider = (model: string, extra: { api_key_env?: string } = {}) =>
  new RemoteEmbeddingProvider({ provider: 'openai-compatible', base_url: `${server.url}/v1`, model, timeout_ms: 2000, ...extra });

test('vectors come back in input order and with unit length', async () => {
  const vectors = await provider('ok').embed(['a', 'b']);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) assert.ok(Math.abs(vector[0] - 0.6) < 1e-6 && Math.abs(vector[1] - 0.8) < 1e-6);
  assert.equal(JSON.parse(server.requests.at(-1)?.body ?? '{}').model, 'ok');
});

test('the version names the endpoint and model, so swapping either rebuilds the index', () => {
  assert.equal(provider('ok').version, `remote:${server.url}/v1:ok`);
});

test('the wrong number of vectors, a zero vector or an HTTP error is a ProviderError', async () => {
  await assert.rejects(provider('too-few').embed(['a', 'b']), ProviderError);
  await assert.rejects(provider('zero').embed(['a']), ProviderError);
  await assert.rejects(provider('down').embed(['a']), (error: unknown) => error instanceof ProviderError && error.status === 503);
});

test('the key comes from the named env variable', async () => {
  process.env.FLOWS_TEST_EMBED_KEY = 'secret';
  try {
    await provider('ok', { api_key_env: 'FLOWS_TEST_EMBED_KEY' }).embed(['a']);
    assert.equal(server.requests.at(-1)?.headers.authorization, 'Bearer secret');
  } finally {
    delete process.env.FLOWS_TEST_EMBED_KEY;
  }
});

test('no texts means no request', async () => {
  const before = server.requests.length;
  assert.deepEqual(await provider('ok').embed([]), []);
  assert.equal(server.requests.length, before);
});
