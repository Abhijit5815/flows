import { z } from 'zod';
import { sha256 } from '../shared/hash.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';
import type { EmbeddingProvider } from './provider.ts';

// A value kept on disk under a key; a different key (model or data changed) recomputes and replaces it.
export async function cached<T>(file: string, key: string, schema: z.ZodType<T>, compute: () => Promise<T>): Promise<T> {
  const stored = readCache(file, z.object({ key: z.string(), value: schema }));
  if (stored?.key === key) return stored.value;
  const value = await compute();
  writeJsonAtomic(file, { key, value });
  return value;
}

// PLAN.md §6 versioned index: vectors for a list of texts, rebuilt when the model or the texts change.
export async function cachedVectors(file: string, texts: readonly string[], provider: EmbeddingProvider): Promise<Float32Array[]> {
  const key = sha256(JSON.stringify({ provider: provider.version, texts }));
  const rows = await cached(file, key, z.array(z.array(z.number())), async () => (await provider.embed(texts)).map((vector) => Array.from(vector)));
  return rows.map((row) => Float32Array.from(row));
}

// Vectors for many texts, each cached on its own under the text's hash, so editing one file re-embeds only the
// texts that changed. Entries not asked for this time are dropped; batches keep the model's input small.
export async function embedEach(file: string, texts: readonly string[], provider: EmbeddingProvider, batch = 16): Promise<Float32Array[]> {
  const stored = readCache(file, z.object({ version: z.literal(provider.version), vectors: z.record(z.string(), z.array(z.number())) }));
  const keys = texts.map((text) => sha256(text));
  const vectors: Record<string, number[]> = {};
  for (const key of keys) if (stored?.vectors[key] !== undefined) vectors[key] = stored.vectors[key];
  const missing = [...new Set(keys.filter((key) => vectors[key] === undefined))];
  for (let i = 0; i < missing.length; i += batch) {
    const chunk = missing.slice(i, i + batch);
    const fresh = await provider.embed(chunk.map((key) => texts[keys.indexOf(key)]));
    chunk.forEach((key, j) => (vectors[key] = Array.from(fresh[j])));
  }
  if (missing.length > 0 || Object.keys(stored?.vectors ?? {}).length !== Object.keys(vectors).length) writeJsonAtomic(file, { version: provider.version, vectors });
  return keys.map((key) => Float32Array.from(vectors[key]));
}
