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

// Tests define routes and pages of their own (a fake app to test middleware against), so they are not the app's source:
// *.test.* and *.spec.* files, __tests__ and __mocks__ folders, and test folders at the repo's root. A test folder
// deeper in (app/test/page.tsx) can be a real page, so it stays.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__)\/|^(tests?|e2e|cypress|playwright)\//;
export const isSource = (path: string): boolean => extname(path) in LANGUAGES && !path.endsWith('.d.ts') && !TEST_FILE.test(path);

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
