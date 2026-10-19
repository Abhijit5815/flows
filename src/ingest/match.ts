import { Lang, parse, type NapiConfig } from '@ast-grep/napi';
import { extname } from 'node:path';
import { z } from 'zod';
import type { SourceFile } from './cache.ts';

// A declarative pattern rule, written as data (an adapter's rules.json, or a learned rule in .flows/).
// `id` says what a match means to the adapter; `rule` and `constraints` are ast-grep's own rule objects.
export const PatternRuleSchema = z.object({
  id: z.string().min(1),
  rule: z.record(z.string(), z.unknown()),
  constraints: z.record(z.string(), z.unknown()).optional(),
  note: z.string().min(1).optional(), // for suspect rules: why a match might be something the graph missed
});

export type PatternRule = z.infer<typeof PatternRuleSchema>;

// Offsets are JavaScript string offsets (ast-grep reports them the same way ts-morph does); line is 1-based.
export const FileFactsSchema = z.object({
  facts: z.array(z.object({ rule: z.string(), start: z.int().min(0), end: z.int().min(0), line: z.int().min(1) })),
  parseErrors: z.int().min(0),
});

export type FileFacts = z.infer<typeof FileFactsSchema>;
export type Fact = FileFacts['facts'][number];

const LANGUAGES: Record<string, Lang> = {
  '.ts': Lang.TypeScript,
  '.mts': Lang.TypeScript,
  '.cts': Lang.TypeScript,
  '.tsx': Lang.Tsx,
  '.jsx': Lang.Tsx,
  '.js': Lang.JavaScript,
  '.mjs': Lang.JavaScript,
  '.cjs': Lang.JavaScript,
};

export const isSource = (path: string): boolean => extname(path) in LANGUAGES && !path.endsWith('.d.ts');

export const languageOf = (path: string): Lang | undefined => LANGUAGES[extname(path)];

// Every match of every rule in one file. The parser recovers from syntax errors, so a broken file still yields
// what it can, and the error count goes to the coverage report.
export function matchRules(rules: readonly PatternRule[], file: SourceFile): FileFacts {
  const root = parse(LANGUAGES[extname(file.path)], file.source).root();
  const facts = rules.flatMap(({ id, rule, constraints }) =>
    root.findAll({ rule, constraints } as NapiConfig).map((node) => {
      const { start, end } = node.range();
      return { rule: id, start: start.index, end: end.index, line: start.line + 1 };
    }),
  );
  return { facts, parseErrors: root.findAll({ rule: { kind: 'ERROR' } }).length };
}
