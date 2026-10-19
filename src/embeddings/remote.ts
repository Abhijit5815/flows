import { z } from 'zod';
import { apiKey, type OpenAiCompatibleConfig } from '../config/project.ts';
import { ProviderError } from '../shared/errors.ts';
import { joinUrl, postJson } from '../shared/http.ts';
import { parseOrThrow } from '../shared/validate.ts';
import type { EmbeddingProvider } from './provider.ts';

const EmbeddingsReplySchema = z.object({
  data: z.array(z.object({ index: z.int().nonnegative(), embedding: z.array(z.number()).min(1) })),
});

function unitLength(values: number[], url: string): Float32Array {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) throw new ProviderError(`${url} returned a zero vector`);
  return vector.map((value) => value / norm);
}

// Any endpoint that speaks the OpenAI /embeddings protocol (PLAN.md §6 remote option).
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly version: string;
  readonly #config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig) {
    this.version = `remote:${config.base_url}:${config.model}`;
    this.#config = config;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const url = joinUrl(this.#config.base_url, 'embeddings');
    const raw = await postJson(url, { model: this.#config.model, input: [...texts] }, { apiKey: apiKey(this.#config), timeoutMs: this.#config.timeout_ms });
    const reply = parseOrThrow(EmbeddingsReplySchema, raw, `reply from ${url}`, ProviderError);
    const rows = [...reply.data].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length || rows.some((row, i) => row.index !== i)) {
      throw new ProviderError(`${url} returned ${rows.length} vectors for ${texts.length} texts`);
    }
    if (new Set(rows.map((row) => row.embedding.length)).size !== 1) throw new ProviderError(`${url} returned vectors of different lengths`);
    return rows.map((row) => unitLength(row.embedding, url));
  }
}
