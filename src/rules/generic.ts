import { parse, type NapiConfig } from '@ast-grep/napi';
import type { Unrecognised } from '../adapters/adapter.ts';
import type { GraphBuilder } from '../graph/builder.ts';
import { languageOf } from '../ingest/match.ts';
import { HTTP_METHODS } from '../model/flow.ts';
import type { GenericRule } from './learned.ts';

export type GenericMatch = { file: string; line: number; method: string | undefined; path: string | undefined };

// The fixed value of a string literal as ast-grep shows it ('/x', "/x" or `/x` without ${}), else undefined.
export function literal(text: string | undefined): string | undefined {
  const quoted = text === undefined ? undefined : /^(['"`])([^]*)\1$/.exec(text);
  return quoted === null || quoted === undefined || (quoted[1] === '`' && quoted[2].includes('${')) ? undefined : quoted[2];
}

// Every match of a generic rule, with what its metavariables captured.
export function genericMatches(rule: GenericRule, sources: ReadonlyMap<string, string>, files?: ReadonlySet<string>): GenericMatch[] {
  const config = { rule: rule.rule.rule, constraints: rule.rule.constraints } as NapiConfig;
  return [...sources].flatMap(([file, source]) => {
    const language = languageOf(file);
    if (language === undefined || (files !== undefined && !files.has(file))) return [];
    return parse(language, source)
      .root()
      .findAll(config)
      .map((match) => {
        const method = rule.method?.startsWith('$') ? match.getMatch(rule.method.slice(1))?.text().toUpperCase() : rule.method;
        return { file, line: match.range().start.line + 1, method, path: literal(match.getMatch(rule.path.slice(1))?.text()) };
      });
  });
}

// Routes or pages from the user's generic rules; a match without a fixed path or a known method is reported.
export function extractGeneric(rules: readonly GenericRule[], sources: ReadonlyMap<string, string>, graph: GraphBuilder, files?: ReadonlySet<string>): Unrecognised[] {
  const notes: Unrecognised[] = [];
  for (const rule of rules) {
    for (const { file, line, method, path } of genericMatches(rule, sources, files)) {
      if (path === undefined || !path.startsWith('/')) {
        notes.push({ file, line, reason: `a learned ${rule.produces} rule matched, but its path is not a fixed string` });
        continue;
      }
      if (rule.produces === 'page') {
        graph.add(`page:${path}`, { kind: 'page', name: path, file, line, attrs: { path } });
        continue;
      }
      const verb = method === 'ALL' || (HTTP_METHODS as readonly string[]).includes(method ?? '') ? method : undefined;
      if (verb === undefined) {
        notes.push({ file, line, reason: `a learned route rule matched, but its method ${method ?? '(none)'} is not an HTTP method` });
        continue;
      }
      graph.add(`route:${verb} ${path}`, { kind: 'route', name: `${verb} ${path}`, file, line, attrs: { method: verb, path } });
    }
  }
  return notes;
}
