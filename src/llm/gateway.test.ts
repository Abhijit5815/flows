import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ConfigError, OutputValidationError, ProviderError } from '../shared/errors.ts';
import { replyJson, startFakeServer } from '../shared/testing/fake-server.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { AnthropicGateway } from './anthropic.ts';
import { createGateway } from './create.ts';
import { OpenAiCompatibleGateway } from './openai-compatible.ts';

const NameSchema = z.object({ name: z.string().min(1) });
const request = (scenario: string) => ({ purpose: 'name-flow', system: 'Name the flow.', prompt: `scenario:${scenario}`, schema: NameSchema });

// The fake answers per scenario, taken from the last message the client sent.
const server = await startFakeServer((req, res) => {
  const body = JSON.parse(req.body);
  const scenario = String(body.messages.at(-1).content).replace('scenario:', '');
  const text = scenario === 'not-json' ? 'Sure! The name is Login.' : scenario === 'wrong-shape' ? '{"title":"Log in"}' : '{"name":"Log in"}';
  if (scenario === 'http-error') return replyJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } });
  if (req.url.startsWith('/v1/chat/completions')) {
    return replyJson(res, 200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
  }
  if (req.url.startsWith('/v1/messages')) {
    const refused = scenario === 'refusal';
    return replyJson(res, 200, {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: refused ? [] : [{ type: 'text', text }],
      stop_reason: refused ? 'refusal' : 'end_turn',
      stop_sequence: null,
      stop_details: refused ? { type: 'refusal', category: 'cyber', explanation: 'test' } : null,
      usage: { input_tokens: 20, output_tokens: 7 },
    });
  }
  replyJson(res, 404, {});
});
after(() => server.close());

const openAi = (trace: MemoryTraceSink, extra: { api_key_env?: string } = {}) =>
  new OpenAiCompatibleGateway({ provider: 'openai-compatible', base_url: `${server.url}/v1`, model: 'llama3.2:3b', timeout_ms: 2000, ...extra }, trace);
const claude = (trace: MemoryTraceSink) =>
  new AnthropicGateway({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }, trace, new Anthropic({ apiKey: 'secret-test-key', baseURL: server.url, maxRetries: 0 }));

const lastRequest = () => {
  const sent = server.requests.at(-1);
  assert.ok(sent);
  return { headers: sent.headers, body: JSON.parse(sent.body) };
};

for (const [name, make] of [['openai-compatible', openAi], ['anthropic', claude]] as const) {
  test(`${name}: a valid reply is returned and traced once with tokens`, async () => {
    const trace = new MemoryTraceSink();
    assert.deepEqual(await make(trace).completeJson(request('ok')), { name: 'Log in' });
    assert.equal(trace.events.length, 1);
    const [event] = trace.events;
    assert.ok(event.kind === 'llm_call' && event.llm_call.ok && event.tokens !== null && event.tokens.output > 0);
  });

  test(`${name}: a reply that is not JSON is rejected and traced with its text`, async () => {
    const trace = new MemoryTraceSink();
    await assert.rejects(make(trace).completeJson(request('not-json')), OutputValidationError);
    const [event] = trace.events;
    assert.ok(event.kind === 'llm_call' && !event.llm_call.ok && event.llm_call.output === 'Sure! The name is Login.');
  });

  test(`${name}: JSON of the wrong shape is rejected`, async () => {
    const trace = new MemoryTraceSink();
    await assert.rejects(make(trace).completeJson(request('wrong-shape')), OutputValidationError);
    assert.equal(trace.events.length, 1);
  });

  test(`${name}: an HTTP error becomes a ProviderError with the status, traced without the key`, async () => {
    const trace = new MemoryTraceSink();
    await assert.rejects(make(trace).completeJson(request('http-error')), (error: unknown) => error instanceof ProviderError && error.status === 400);
    assert.equal(trace.events.length, 1);
    assert.ok(!JSON.stringify(trace.events).includes('secret-test-key'));
  });
}

test('openai-compatible: sends model, messages and a json_schema response format', async () => {
  await openAi(new MemoryTraceSink()).completeJson(request('ok'));
  const { body } = lastRequest();
  assert.equal(body.model, 'llama3.2:3b');
  assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(body.response_format.json_schema.schema.required, ['name']);
});

test('openai-compatible: sends the key from the named env variable as a bearer token', async () => {
  process.env.FLOWS_TEST_LLM_KEY = 'secret-test-key';
  try {
    const trace = new MemoryTraceSink();
    await openAi(trace, { api_key_env: 'FLOWS_TEST_LLM_KEY' }).completeJson(request('ok'));
    assert.equal(lastRequest().headers.authorization, 'Bearer secret-test-key');
    assert.ok(!JSON.stringify(trace.events).includes('secret-test-key'));
  } finally {
    delete process.env.FLOWS_TEST_LLM_KEY;
  }
});

test('anthropic: sends structured output, low effort and the server-side fallback', async () => {
  await claude(new MemoryTraceSink()).completeJson(request('ok'));
  const { headers, body } = lastRequest();
  assert.match(String(headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.system, 'Name the flow.');
});

test('anthropic: a refusal fails closed as a ProviderError naming the category', async () => {
  const trace = new MemoryTraceSink();
  await assert.rejects(claude(trace).completeJson(request('refusal')), (error: unknown) => error instanceof ProviderError && /cyber/.test(error.message));
  const [event] = trace.events;
  assert.ok(event.kind === 'llm_call' && !event.llm_call.ok);
});

test('anthropic: a request that cannot be sent (e.g. no credentials) is a ConfigError, traced once', async () => {
  // The stub only needs beta.messages.create; it throws the plain Error the SDK uses for missing credentials.
  const offline = { beta: { messages: { create: async () => { throw new Error('Could not resolve authentication method.'); } } } } as unknown as Anthropic;
  const trace = new MemoryTraceSink();
  const gateway = new AnthropicGateway({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }, trace, offline);
  await assert.rejects(gateway.completeJson(request('ok')), (error: unknown) => error instanceof ConfigError && /ANTHROPIC_API_KEY/.test(error.message));
  assert.equal(trace.events.length, 1);
});

test('createGateway picks the implementation from config', () => {
  const trace = new MemoryTraceSink();
  assert.ok(createGateway({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }, trace) instanceof AnthropicGateway);
  assert.ok(createGateway({ provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'm', timeout_ms: 1 }, trace) instanceof OpenAiCompatibleGateway);
});
