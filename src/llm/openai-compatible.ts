import { z } from 'zod';
import { apiKey, type OpenAiCompatibleConfig } from '../config/project.ts';
import { ProviderError } from '../shared/errors.ts';
import { joinUrl, postJson } from '../shared/http.ts';
import { parseOrThrow } from '../shared/validate.ts';
import type { TraceSink } from '../trace/sink.ts';
import { completeTraced, type LlmGateway, type LlmRequest } from './gateway.ts';

const ChatReplySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() }).optional(),
});

// Any endpoint that speaks the OpenAI chat-completions protocol, e.g. Ollama at http://localhost:11434/v1.
export class OpenAiCompatibleGateway implements LlmGateway {
  readonly model: string;
  readonly #config: OpenAiCompatibleConfig;
  readonly #trace: TraceSink;

  constructor(config: OpenAiCompatibleConfig, trace: TraceSink) {
    this.model = config.model;
    this.#config = config;
    this.#trace = trace;
  }

  completeJson<T>(request: LlmRequest<T>): Promise<T> {
    return completeTraced(this.#trace, { provider: 'openai-compatible', model: this.model }, request, async () => {
      const body = {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        // Not every server honours json_schema; the Zod check in completeTraced is the real guard.
        response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: z.toJSONSchema(request.schema) } },
      };
      const url = joinUrl(this.#config.base_url, 'chat/completions');
      const raw = await postJson(url, body, { apiKey: apiKey(this.#config), timeoutMs: this.#config.timeout_ms });
      const reply = parseOrThrow(ChatReplySchema, raw, `reply from ${url}`, ProviderError);
      const text = reply.choices[0].message.content;
      if (text === null) throw new ProviderError(`${this.model} returned no content`);
      return { text, tokens: reply.usage ? { input: reply.usage.prompt_tokens, output: reply.usage.completion_tokens } : null };
    });
  }
}
