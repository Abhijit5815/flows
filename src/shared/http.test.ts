import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from './errors.ts';
import { joinUrl, postJson } from './http.ts';
import { replyJson, startFakeServer } from './testing/fake-server.ts';

const server = await startFakeServer((request, response) => {
  if (request.url === '/ok') replyJson(response, 200, { echo: JSON.parse(request.body) });
  else if (request.url === '/fail') replyJson(response, 500, { error: 'boom' });
  else if (request.url === '/not-json') response.end('plain text');
  else if (request.url === '/slow') setTimeout(() => replyJson(response, 200, {}), 500);
});
after(() => server.close());

const isProviderError = (status: number | undefined) => (error: unknown) =>
  error instanceof ProviderError && error.status === status && !/secret-key/.test(error.message);

test('postJson sends JSON and the bearer key, and returns the parsed reply', async () => {
  const reply = await postJson(`${server.url}/ok`, { a: 1 }, { apiKey: 'secret-key', timeoutMs: 2000 });
  assert.deepEqual(reply, { echo: { a: 1 } });
  const sent = server.requests.at(-1);
  assert.equal(sent?.headers.authorization, 'Bearer secret-key');
  assert.equal(sent?.headers['content-type'], 'application/json');
});

test('postJson leaves out the authorization header when there is no key', async () => {
  await postJson(`${server.url}/ok`, {}, { timeoutMs: 2000 });
  assert.equal(server.requests.at(-1)?.headers.authorization, undefined);
});

test('postJson turns an HTTP error into a ProviderError with the status', async () => {
  await assert.rejects(postJson(`${server.url}/fail`, {}, { apiKey: 'secret-key', timeoutMs: 2000 }), isProviderError(500));
});

test('postJson rejects a reply that is not JSON', async () => {
  await assert.rejects(postJson(`${server.url}/not-json`, {}, { timeoutMs: 2000 }), isProviderError(200));
});

test('postJson turns a timeout into a ProviderError', async () => {
  await assert.rejects(postJson(`${server.url}/slow`, {}, { timeoutMs: 50 }), isProviderError(undefined));
});

test('postJson turns a refused connection into a ProviderError', async () => {
  await assert.rejects(postJson('http://127.0.0.1:1/nothing-here', {}, { timeoutMs: 2000 }), isProviderError(undefined));
});

test('joinUrl adds a path with or without a trailing slash on the base', () => {
  assert.equal(joinUrl('http://h/v1', 'embeddings'), 'http://h/v1/embeddings');
  assert.equal(joinUrl('http://h/v1/', 'embeddings'), 'http://h/v1/embeddings');
});
