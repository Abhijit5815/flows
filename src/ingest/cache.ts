import { z } from 'zod';
import { sha256 } from '../shared/hash.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';

export type SourceFile = { path: string; source: string };

// Per-file facts, recomputed only for files whose content hash changed since the last scan (PLAN.md Phase 2).
// `version` names everything else the facts depend on (adapter rules, learned rules); a new version recomputes all.
// `computed` lists the files that were parsed this time.
export function cachedFacts<T>(
  file: string,
  version: string,
  schema: z.ZodType<T>,
  sources: readonly SourceFile[],
  compute: (source: SourceFile) => T,
): { facts: Map<string, T>; computed: string[] } {
  const stored = readCache(file, z.object({ version: z.literal(version), files: z.record(z.string(), z.object({ hash: z.string(), facts: schema })) }));
  const files: Record<string, { hash: string; facts: T }> = {};
  const computed: string[] = [];
  for (const source of sources) {
    const hash = sha256(source.source);
    const hit = stored?.files[source.path];
    if (hit?.hash === hash) {
      files[source.path] = hit;
    } else {
      files[source.path] = { hash, facts: compute(source) };
      computed.push(source.path);
    }
  }
  // Same count and nothing recomputed means the same files with the same content: no write needed.
  if (computed.length > 0 || Object.keys(stored?.files ?? {}).length !== sources.length) writeJsonAtomic(file, { version, files });
  return { facts: new Map(Object.entries(files).map(([path, entry]) => [path, entry.facts])), computed };
}
