import { z } from 'zod';
import type { LlmGateway, LlmRequest } from '../llm/gateway.ts';
import { ConfigError, OutputValidationError, PendingAnswer, ProviderError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { appendJsonLine, readCache, readJsonLines, writeJsonAtomic } from '../shared/json-file.ts';

// The answers that end up in the flows. With an answers file (the project's .flows/answers.jsonl), they are kept there
// by prompt alone, whatever model gave them, so a team that commits it gets the same flows and pays for each answer once.
// The rest (live form values, rule drafts) carry page and code details and stay in the local cache.
const SHARED = new Set(['flow-name', 'flow-category']);
const AnswerSchema = z.object({ key: z.string(), value: z.unknown() });

// The flow engine's LLM is optional (PLAN.md Phase 4: only unknown categories, names and descriptions):
// - a reply is kept on disk by its prompt, so unchanged flows cost no tokens on the next scan (PLAN.md §8);
//   flow names and categories go to the shared answers file when there is one (see SHARED);
// - a reply that fails its schema is dropped, and the flow keeps what source gave it;
// - the first provider or config failure turns the LLM off for the rest of the run and is reported once.
export class OptionalLlm {
  readonly #gateway: LlmGateway | undefined;
  readonly #cacheFile: string;
  readonly #answersFile: string | undefined;
  readonly #onOff: (reason: string) => void;
  #cache: Record<string, unknown> | undefined;
  #answers: Map<string, unknown> | undefined;
  #off = false;
  pending = 0; // requests waiting for the coding assistant (the assistant provider)

  constructor(gateway: LlmGateway | undefined, cacheFile: string, onOff: (reason: string) => void, answersFile?: string) {
    this.#gateway = gateway;
    this.#cacheFile = cacheFile;
    this.#onOff = onOff;
    this.#answersFile = answersFile;
  }

  #shared(request: LlmRequest<unknown>): boolean {
    return this.#answersFile !== undefined && SHARED.has(request.purpose);
  }

  #key(request: LlmRequest<unknown>, model: string): string {
    return sha256(JSON.stringify(this.#shared(request) ? [request.purpose, request.system, request.prompt] : [model, request.purpose, request.system, request.prompt]));
  }

  #kept(request: LlmRequest<unknown>, key: string): unknown {
    if (!this.#shared(request)) return (this.#cache ??= readCache(this.#cacheFile, z.record(z.string(), z.unknown())) ?? {})[key];
    // The latest line for a key wins; null is a refused answer.
    this.#answers ??= new Map(readJsonLines(this.#answersFile as string, AnswerSchema).map((line) => [line.key, line.value]));
    return this.#answers.get(key);
  }

  #keep(request: LlmRequest<unknown>, key: string, value: unknown): void {
    if (!this.#shared(request)) {
      if (value === null) delete this.#cache?.[key];
      else (this.#cache ??= {})[key] = value;
      writeJsonAtomic(this.#cacheFile, this.#cache ?? {});
      return;
    }
    // shortcut: answers for prompts the code no longer produces stay in the file; prune them if it grows too large.
    this.#answers?.set(key, value);
    appendJsonLine(this.#answersFile as string, { key, value });
  }

  // A reply a later check refused (a name the steps don't support): the assistant gets the job back with the reason,
  // so it can try again; a model's reply stays cached, so the same request isn't paid for again on every scan.
  refuse(request: LlmRequest<unknown>, why: string): void {
    if (this.#gateway?.refuse === undefined) return;
    this.#gateway.refuse(request, why);
    const key = this.#key(request, this.#gateway.model);
    if ((this.#kept(request, key) ?? null) !== null) this.#keep(request, key, null);
  }

  async ask<T>(request: LlmRequest<T>): Promise<T | undefined> {
    if (this.#gateway === undefined) return undefined;
    const key = this.#key(request, this.#gateway.model);
    const kept = request.schema.safeParse(this.#kept(request, key));
    if (kept.success) return kept.data;
    if (this.#off) return undefined;
    try {
      const reply = await this.#gateway.completeJson(request);
      this.#keep(request, key, reply);
      return reply;
    } catch (error) {
      if (error instanceof OutputValidationError) return undefined;
      if (error instanceof PendingAnswer) {
        this.pending++;
        return undefined;
      }
      if (error instanceof ProviderError || error instanceof ConfigError) {
        this.#off = true;
        this.#onOff(error.message);
        return undefined;
      }
      throw error;
    }
  }
}
