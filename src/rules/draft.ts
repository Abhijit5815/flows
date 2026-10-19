import { z } from 'zod';
import type { LlmGateway } from '../llm/gateway.ts';
import { HTTP_METHODS } from '../model/flow.ts';
import { genericMatches } from './generic.ts';
import { today, type GenericRule } from './learned.ts';

// PLAN.md Phase 2, unknown framework: the LLM drafts a rule from examples the user marks, and the rule is kept only
// if it reproduces those examples exactly (it matches every one, matches nothing else, and reads a fixed path and,
// for routes, a method at each).
export const DraftSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().regex(/^\$[A-Z_][A-Z0-9_]*$/),
  method: z.string().min(1).optional(),
});

export type Draft = z.infer<typeof DraftSchema>;
export type DraftResult = { accepted: true; rule: GenericRule } | { accepted: false; reason: string };

const isMethod = (method: string | undefined) => method === 'ALL' || (HTTP_METHODS as readonly string[]).includes(method ?? '');

export function checkDraft(draft: Draft, produces: 'route' | 'page', examples: readonly string[], sources: ReadonlyMap<string, string>): DraftResult {
  const rule: GenericRule = {
    type: 'generic',
    produces,
    rule: { id: 'draft', rule: { pattern: draft.pattern } },
    path: draft.path,
    ...(produces === 'route' && draft.method !== undefined ? { method: draft.method } : {}),
    examples: [...examples],
    added: today(),
  };
  if (produces === 'route' && draft.method === undefined) return { accepted: false, reason: 'a route rule needs a method (a metavariable such as $METHOD, or a fixed method)' };
  let matches;
  try {
    matches = genericMatches(rule, sources);
  } catch (error) {
    return { accepted: false, reason: `the pattern is not valid ast-grep: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }
  const found = new Set(matches.map((match) => `${match.file}:${match.line}`));
  const missing = examples.filter((example) => !found.has(example));
  if (missing.length > 0) return { accepted: false, reason: `it does not match ${missing.join(', ')}` };
  const extra = [...found].filter((place) => !examples.includes(place));
  if (extra.length > 0) return { accepted: false, reason: `it also matches ${extra.join(', ')}; if those are ${produces}s too, mark them as examples and draft again` };
  const unread = matches.filter((match) => match.path === undefined || !match.path.startsWith('/') || (produces === 'route' && !isMethod(match.method)));
  if (unread.length > 0) return { accepted: false, reason: `it can't read a fixed path${produces === 'route' ? ' and an HTTP method' : ''} at ${unread.map((match) => `${match.file}:${match.line}`).join(', ')}` };
  return { accepted: true, rule };
}

export async function draftRule(gateway: LlmGateway, produces: 'route' | 'page', examples: readonly string[], sources: ReadonlyMap<string, string>): Promise<DraftResult> {
  const shown = examples.map((example) => {
    const [file, line] = [example.slice(0, example.lastIndexOf(':')), Number(example.slice(example.lastIndexOf(':') + 1))];
    return `${example}:\n${(sources.get(file) ?? '').split('\n').slice(line - 1, line + 2).join('\n')}`;
  });
  const what = produces === 'route' ? 'HTTP route registrations' : 'page definitions';
  const reply = produces === 'route' ? '{"pattern": "...", "path": "$PATH", "method": "$METHOD"}' : '{"pattern": "...", "path": "$PATH"}';
  const draft = await gateway.completeJson({
    purpose: 'draft-rule',
    system:
      `You write ast-grep patterns that find ${what} in JavaScript and TypeScript code. A pattern is a code snippet ` +
      'in which $NAME matches any single node and $$$NAME matches zero or more nodes (such as the remaining arguments); ' +
      `everything else must match exactly. It is code, not a regular expression. Reply with JSON only: ${reply}. ` +
      '"path" names the metavariable that captures the URL path string' +
      (produces === 'route' ? '; "method" names the metavariable that captures the HTTP method, or is a fixed method such as "GET"' : '') +
      '. Example: for the lines `server.route("GET", "/a", show)` and `server.route("POST", "/b", save)`, the answer is ' +
      '{"pattern": "server.route($METHOD, $PATH, $$$REST)", "path": "$PATH", "method": "$METHOD"}.',
    prompt: `Each example below starts on the line given. Write one pattern that matches every example and nothing else.\n\n${shown.join('\n\n')}`,
    schema: DraftSchema,
  });
  return checkDraft(draft, produces, examples, sources);
}
