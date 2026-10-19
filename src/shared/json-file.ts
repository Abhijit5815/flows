import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';

// Written to a temp file, then renamed, so a crash never leaves a half-written file.
export function writeJsonAtomic(file: string, value: unknown, indent?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, indent)}\n`);
  renameSync(`${file}.tmp`, file);
}

// For cache files only: missing, damaged or outdated reads as undefined, and the caller recomputes it.
export function readCache<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
