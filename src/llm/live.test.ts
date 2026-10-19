// Real model calls; run with FLOWS_LIVE_TESTS=1. Claude needs ANTHROPIC_API_KEY or an `ant auth login` profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { LlmConfig } from '../config/project.ts';
import { liveSkip } from '../shared/testing/live.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { createGateway } from './create.ts';

const request = {
  purpose: 'name-flow',
  system: 'You name user flows found in a web app. Reply with JSON only.',
  prompt:
    'Steps: 1. Open /login. 2. Submit the form with email and password. 3. The app redirects to /dashboard. ' +
    'Give the flow a short name and a one-sentence description.',
  schema: z.object({ name: z.string().min(1).max(80), description: z.string().min(1).max(300) }),
};

const configs: LlmConfig[] = [
  { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' },
  { provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.2:3b', timeout_ms: 120_000 },
];

// The hosted check stays open (PLAN.md §13) until someone runs it with their own key.
const hostedSkip = liveSkip || (process.env.ANTHROPIC_API_KEY ? false : 'hosted check is open (PLAN.md §13): set ANTHROPIC_API_KEY to run it');

for (const config of configs) {
  const skip = config.provider === 'anthropic' ? hostedSkip : liveSkip;
  test(`live: ${config.provider} ${config.model} answers with schema-valid JSON, traced once`, { skip }, async (t) => {
    const trace = new MemoryTraceSink();
    const answer = await createGateway(config, trace).completeJson(request);
    const [event] = trace.events;
    assert.equal(trace.events.length, 1);
    assert.ok(event.kind === 'llm_call' && event.llm_call.ok);
    t.diagnostic(`${config.model} -> ${JSON.stringify(answer)} | tokens ${JSON.stringify(event.tokens)} | ${event.duration_ms.toFixed(0)} ms`);
  });
}
