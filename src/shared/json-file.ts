import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import { ConfigError } from './errors.ts';
import { parseOrThrow } from './validate.ts';

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

// For the files a team commits (.flows/*.jsonl): one record per line, only ever appended. Git's union merge driver,
// set in the .gitattributes written beside them, keeps the lines of both branches, so two people never conflict.
export function appendJsonLine(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const attributes = join(dirname(file), '.gitattributes');
  if (!existsSync(attributes)) writeFileSync(attributes, '*.jsonl merge=union\n');
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

// A bad line stops the caller with its place rather than being skipped: these files are people's own work.
export function readJsonLines<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, i) => {
      if (line.trim() === '') return [];
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        throw new ConfigError(`${file}:${i + 1} is not valid JSON`, { cause: error });
      }
      return [parseOrThrow(schema, raw, `${file}:${i + 1}`, ConfigError)];
    });
}
