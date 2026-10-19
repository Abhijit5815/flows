import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../shared/hash.ts';
import type { EmbeddingProvider } from './provider.ts';

function readStored<T>(file: string, schema: z.ZodType<T>): { key: string; value: T } | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const stored = z.object({ key: z.string(), value: schema }).safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return stored.success ? stored.data : undefined;
  } catch {
    return undefined; // a damaged cache file is rebuilt; it only ever holds data we can recompute
  }
}

// A value kept on disk under a key; a different key (model or data changed) recomputes and replaces it.
export async function cached<T>(file: string, key: string, schema: z.ZodType<T>, compute: () => Promise<T>): Promise<T> {
  const stored = readStored(file, schema);
  if (stored?.key === key) return stored.value;
  const value = await compute();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ key, value }));
  renameSync(`${file}.tmp`, file);
  return value;
}

// PLAN.md §6 versioned index: vectors for a list of texts, rebuilt when the model or the texts change.
export async function cachedVectors(file: string, texts: readonly string[], provider: EmbeddingProvider): Promise<Float32Array[]> {
  const key = sha256(JSON.stringify({ provider: provider.version, texts }));
  const rows = await cached(file, key, z.array(z.array(z.number())), async () => (await provider.embed(texts)).map((vector) => Array.from(vector)));
  return rows.map((row) => Float32Array.from(row));
}
