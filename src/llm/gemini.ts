import { z } from 'zod';
import type { GeminiConfig } from '../config/project.ts';
import { ConfigError, ProviderError } from '../shared/errors.ts';
import { postJson } from '../shared/http.ts';
import { parseOrThrow } from '../shared/validate.ts';
import type { TraceSink } from '../trace/sink.ts';
import { completeTraced, type LlmGateway, type LlmRequest } from './gateway.ts';

const ReplySchema = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).default([]) }).optional(), finishReason: z.string().optional() })).default([]),
  usageMetadata: z.object({ promptTokenCount: z.int().nonnegative().optional(), candidatesTokenCount: z.int().nonnegative().optional() }).optional(),
});

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google answers 429 and 503 when a model is busy, and a minute later it is fine: wait and ask again before giving up,
// because one refusal turns the AI off for the rest of a run.
const RETRY_AFTER_MS = [2_000, 6_000, 15_000, 30_000];
const BUSY = new Set([429, 500, 503]);

// Gemini through Google's own generateContent API (its OpenAI-style endpoint does not take every key). The key is
// read from the variable the config names and sent in the x-goog-api-key header; JSON is asked for, and the Zod
// check in completeTraced is the real guard.
export class GeminiGateway implements LlmGateway {
  readonly model: string;
  readonly #config: GeminiConfig;
  readonly #trace: TraceSink;
  readonly #base: string;
  readonly #waits: readonly number[];

  constructor(config: GeminiConfig, trace: TraceSink, base = BASE, waits: readonly number[] = RETRY_AFTER_MS) {
    this.model = config.model;
    this.#config = config;
    this.#trace = trace;
    this.#base = base;
    this.#waits = waits;
  }

  completeJson<T>(request: LlmRequest<T>): Promise<T> {
    return completeTraced(this.#trace, { provider: 'gemini', model: this.model }, request, async () => {
      const key = process.env[this.#config.api_key_env];
      if (!key) throw new ConfigError(`environment variable ${this.#config.api_key_env} is not set`);
      const url = `${this.#base}/${encodeURIComponent(this.model)}:generateContent`;
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      };
      let raw: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          raw = await postJson(url, body, { timeoutMs: this.#config.timeout_ms, headers: { 'x-goog-api-key': key } });
          break;
        } catch (error) {
          const wait = this.#waits[attempt];
          if (wait === undefined || !(error instanceof ProviderError) || error.status === undefined || !BUSY.has(error.status)) throw error;
          await new Promise((done) => setTimeout(done, wait));
        }
      }
      const reply = parseOrThrow(ReplySchema, raw, `reply from ${url}`, ProviderError);
      const candidate = reply.candidates[0];
      const text = candidate?.content?.parts.map((part) => part.text ?? '').join('') ?? '';
      if (text === '') throw new ProviderError(`${this.model} returned no content${candidate?.finishReason === undefined ? '' : ` (${candidate.finishReason})`}`);
      const usage = reply.usageMetadata;
      return { text, tokens: usage?.promptTokenCount === undefined || usage.candidatesTokenCount === undefined ? null : { input: usage.promptTokenCount, output: usage.candidatesTokenCount } };
    });
  }
}
