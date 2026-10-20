import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { OptionalLlm } from '../engine/llm.ts';
import { OutputValidationError, PendingAnswer } from '../shared/errors.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { answerJob, AssistantGateway, loadJobs } from './assistant.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-assistant-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const request = { purpose: 'flow-name', system: 'Name the flow.', prompt: 'Open /login. Fill in and submit LoginForm#form (email, password).', schema: z.object({ name: z.string().min(3) }) };

test('a request without an answer becomes a job; the answer is checked when given and again when used', async () => {
  const file = join(tmp, 'jobs.json');
  const trace = new MemoryTraceSink();
  const gateway = new AssistantGateway(file, trace);
  await assert.rejects(gateway.completeJson(request), PendingAnswer);
  const [[id, job]] = Object.entries(loadJobs(file));
  assert.deepEqual([job.purpose, job.prompt, (job.schema as { required: string[] }).required], ['flow-name', request.prompt, ['name']]);
  assert.throws(() => answerJob(file, id, 'not json'), OutputValidationError);
  assert.throws(() => answerJob(file, id, '{"name": "x"}'), OutputValidationError, 'too short for the schema');
  answerJob(file, id, '{"name": "Log in with email and password"}');
  assert.deepEqual(await gateway.completeJson(request), { name: 'Log in with email and password' });
  const [event] = trace.events;
  assert.ok(event.kind === 'llm_call' && event.llm_call.provider === 'assistant' && event.llm_call.ok);
});

test('an answer the scan refuses is dropped, and the job waits again with the reason', async () => {
  const file = join(tmp, 'refused.json');
  const gateway = new AssistantGateway(file, new MemoryTraceSink());
  await assert.rejects(gateway.completeJson(request), PendingAnswer);
  const [[id, job]] = Object.entries(loadJobs(file));
  writeFileSync(file, JSON.stringify({ [id]: { ...job, answer: '{"title": "no name field"}' } }));
  await assert.rejects(gateway.completeJson(request), OutputValidationError);
  assert.equal(loadJobs(file)[id].answer, undefined);
  assert.match(loadJobs(file)[id].error ?? '', /name/);
  await assert.rejects(gateway.completeJson(request), PendingAnswer);
});

test('the flow engine counts what waits for the assistant and goes on without it', async () => {
  const llm = new OptionalLlm(new AssistantGateway(join(tmp, 'engine.json'), new MemoryTraceSink()), join(tmp, 'cache.json'), () => assert.fail('the assistant is never "off"'));
  assert.equal(await llm.ask(request), undefined);
  assert.equal(await llm.ask({ ...request, prompt: 'Open /cart.' }), undefined);
  assert.equal(llm.pending, 2);
});
