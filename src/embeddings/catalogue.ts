import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';

const CatalogueEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9.-]+$/),
  source: z.url(), // the publisher's own repo (PLAN.md §6: weights come from the original source)
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  license: z.string().min(1), // as stated on the model card
  dtype: z.enum(['fp32', 'q8']),
  pooling: z.enum(['cls', 'mean', 'last_token']),
  dims: z.int().positive(),
  max_tokens: z.int().positive(),
  files: z.array(z.object({ path: z.string().min(1), size: z.int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
});

export type CatalogueEntry = z.infer<typeof CatalogueEntrySchema>;

const CatalogueSchema = z
  .array(CatalogueEntrySchema)
  .min(1)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, { message: 'model ids must be unique' });

export const CATALOGUE: readonly CatalogueEntry[] = parseOrThrow(
  CatalogueSchema,
  JSON.parse(readFileSync(new URL('./catalogue.json', import.meta.url), 'utf8')),
  'src/embeddings/catalogue.json',
  ConfigError,
);

export function catalogueEntry(id: string): CatalogueEntry {
  const entry = CATALOGUE.find((candidate) => candidate.id === id);
  if (!entry) throw new ConfigError(`unknown embedding model "${id}"; the catalogue has ${CATALOGUE.map((e) => e.id).join(', ')}`);
  return entry;
}
