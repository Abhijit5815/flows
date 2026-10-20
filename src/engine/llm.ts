import { z } from 'zod';
import type { LlmGateway, LlmRequest } from '../llm/gateway.ts';
import { ConfigError, OutputValidationError, ProviderError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';

// The flow engine's LLM is optional (PLAN.md Phase 4: only unknown categories, names and descriptions):
// - a reply is kept on disk by its prompt, so unchanged flows cost no tokens on the next scan (PLAN.md §8);
// - a reply that fails its schema is dropped, and the flow keeps what source gave it;
// - the first provider or config failure turns the LLM off for the rest of the run and is reported once.
export class OptionalLlm {
  readonly #gateway: LlmGateway | undefined;
  readonly #cacheFile: string;
  readonly #onOff: (reason: string) => void;
  #cache: Record<string, unknown> | undefined;
  #off = false;

  constructor(gateway: LlmGateway | undefined, cacheFile: string, onOff: (reason: string) => void) {
    this.#gateway = gateway;
    this.#cacheFile = cacheFile;
    this.#onOff = onOff;
  }

  async ask<T>(request: LlmRequest<T>): Promise<T | undefined> {
    if (this.#gateway === undefined) return undefined;
    const key = sha256(JSON.stringify([this.#gateway.model, request.purpose, request.system, request.prompt]));
    this.#cache ??= readCache(this.#cacheFile, z.record(z.string(), z.unknown())) ?? {};
    const kept = request.schema.safeParse(this.#cache[key]);
    if (kept.success) return kept.data;
    if (this.#off) return undefined;
    try {
      const reply = await this.#gateway.completeJson(request);
      this.#cache[key] = reply;
      writeJsonAtomic(this.#cacheFile, this.#cache);
      return reply;
    } catch (error) {
      if (error instanceof OutputValidationError) return undefined;
      if (error instanceof ProviderError || error instanceof ConfigError) {
        this.#off = true;
        this.#onOff(error.message);
        return undefined;
      }
      throw error;
    }
  }
}
