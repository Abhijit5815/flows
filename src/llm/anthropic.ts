import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { LlmConfig } from '../config/project.ts';
import { ConfigError, ProviderError } from '../shared/errors.ts';
import type { TraceSink } from '../trace/sink.ts';
import { completeTraced, type LlmGateway, type LlmRequest } from './gateway.ts';

type AnthropicConfig = Extract<LlmConfig, { provider: 'anthropic' }>;

// Claude through the official SDK, as Anthropic recommends, with structured output and
// the server-side refusal fallback. Credentials come from ANTHROPIC_API_KEY or an `ant auth login` profile.
export class AnthropicGateway implements LlmGateway {
  readonly model: string;
  readonly #effort: AnthropicConfig['effort'];
  readonly #trace: TraceSink;
  #client: Anthropic | undefined;

  constructor(config: AnthropicConfig, trace: TraceSink, client?: Anthropic) {
    this.model = config.model;
    this.#effort = config.effort;
    this.#trace = trace;
    this.#client = client;
  }

  completeJson<T>(request: LlmRequest<T>): Promise<T> {
    return completeTraced(this.#trace, { provider: 'anthropic', model: this.model }, request, async () => {
      let message;
      try {
        // create, not parse: parse throws a generic error on output that doesn't validate, so
        // completeTraced does the one Zod check and keeps the raw reply in the trace.
        message = await (this.#client ??= new Anthropic()).beta.messages.create({
          model: this.model,
          max_tokens: 16_000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { format: betaZodOutputFormat(request.schema), effort: this.#effort },
        });
      } catch (error) {
        if (error instanceof Anthropic.APIError) {
          throw new ProviderError(`Claude request failed: ${error.message}`, error.status, { cause: error });
        }
        // Anything else means the request never left this machine. The SDK checks credentials only
        // at request time and throws a plain Error, so this is where "no credentials" lands.
        const reason = error instanceof Error ? error.message : String(error);
        throw new ConfigError(`could not send the request to Claude (${reason}); set ANTHROPIC_API_KEY or run "ant auth login"`, { cause: error });
      }
      // Fail closed: a declined request leaves the item unknown instead of guessing.
      if (message.stop_reason === 'refusal') {
        throw new ProviderError(`Claude declined the request (${message.stop_details?.category ?? 'no category given'})`);
      }
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      return { text, tokens: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
    });
  }
}
