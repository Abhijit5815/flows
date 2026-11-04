import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ConfigError, ProviderError } from '../shared/errors.ts';
import { replyJson, startFakeServer } from '../shared/testing/fake-server.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { GeminiGateway } from './gemini.ts';

const KEY = 'test-key-value-123';
let busy = 0; // how many more times the fake says it is busy
const server = await startFakeServer((req, res) => {
  const prompt = String(JSON.parse(req.body).contents[0].parts[0].text);
  if (prompt === 'busy' && busy-- > 0) return replyJson(res, 503, { error: { message: 'high demand' } });
  if (prompt === 'denied') return replyJson(res, 400, { error: { message: 'Please pass a valid API key' } });
  if (prompt === 'empty') return replyJson(res, 200, { candidates: [{ finishReason: 'SAFETY' }] });
  replyJson(res, 200, { candidates: [{ content: { parts: [{ text: '{"name":' }, { text: '"Log in"}' }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } });
});
after(() => server.close());

const gateway = (trace = new MemoryTraceSink()) => new GeminiGateway({ provider: 'gemini', model: 'gemini-2.5-flash', api_key_env: 'FLOWS_TEST_GEMINI_KEY', timeout_ms: 2000 }, trace, `${server.url}/v1beta/models`, [0, 0]);
const ask = (prompt: string, trace?: MemoryTraceSink) => gateway(trace).completeJson({ purpose: 'name-flow', system: 'Name the flow.', prompt, schema: z.object({ name: z.string().min(1) }) });

test('gemini: the key travels in a header only, the reply parts are joined, and tokens are traced', async () => {
  process.env.FLOWS_TEST_GEMINI_KEY = KEY;
  const trace = new MemoryTraceSink();
  assert.deepEqual(await ask('ok', trace), { name: 'Log in' });
  const sent = server.requests.at(-1);
  assert.ok(sent);
  assert.equal(sent.headers['x-goog-api-key'], KEY);
  assert.ok(!sent.url.includes(KEY) && !sent.body.includes(KEY), 'the key is not in the URL or the body');
  assert.match(sent.url, /^\/v1beta\/models\/gemini-2\.5-flash:generateContent/);
  assert.deepEqual(JSON.parse(sent.body).generationConfig, { responseMimeType: 'application/json' });
  const [event] = trace.events;
  assert.ok(event.kind === 'llm_call' && event.llm_call.ok && event.tokens?.output === 4);
});

test('gemini: a missing key, a refused request and an empty reply each say why, and never print the key', async () => {
  delete process.env.FLOWS_TEST_GEMINI_KEY;
  await assert.rejects(ask('ok'), (error: Error) => error instanceof ConfigError && /FLOWS_TEST_GEMINI_KEY is not set/.test(error.message));
  process.env.FLOWS_TEST_GEMINI_KEY = KEY;
  await assert.rejects(ask('denied'), (error: Error) => error instanceof ProviderError && /returned 400/.test(error.message) && !error.message.includes(KEY));
  await assert.rejects(ask('empty'), (error: Error) => error instanceof ProviderError && /returned no content \(SAFETY\)/.test(error.message));
});

test('gemini: a busy model (503) is asked again, but not forever, and a refused key is not retried', async () => {
  process.env.FLOWS_TEST_GEMINI_KEY = KEY;
  busy = 2;
  const before = server.requests.length;
  assert.deepEqual(await ask('busy'), { name: 'Log in' });
  assert.equal(server.requests.length - before, 3, 'two refusals, then the answer');
  busy = 99;
  const again = server.requests.length;
  await assert.rejects(ask('busy'), (error: Error) => error instanceof ProviderError && /returned 503/.test(error.message));
  assert.equal(server.requests.length - again, 3, 'the first try and two retries, as many as there are waits');
  const denied = server.requests.length;
  await assert.rejects(ask('denied'));
  assert.equal(server.requests.length - denied, 1, 'a 400 is final');
});
