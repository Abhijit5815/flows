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
