import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PatternRuleSchema } from '../ingest/match.ts';
import { ConfigError } from '../shared/errors.ts';
import { writeJsonAtomic } from '../shared/json-file.ts';
import { parseOrThrow } from '../shared/validate.ts';

// PLAN.md §4 Rule { scope, pattern | exclusion }: what the user taught Flows about one repo. Saved in the repo
// itself (<repo>/.flows/rules.json), so it is reviewed and versioned with the code it describes.
const Added = z.iso.date();
const Place = z.string().regex(/^.+:[1-9]\d*$/, 'a place looks like "src/server.ts:17"');

export const FEEDBACK_KINDS = ['correct', 'wrong', 'never', 'missing-step', 'comment'] as const;

export const LearnedRuleSchema = z.discriminatedUnion('type', [
  // "You missed this": one more pattern for one of an adapter's own rules (scope: the adapter id).
  z.object({ type: z.literal('pattern'), scope: z.string().min(1), rule: PatternRuleSchema, example: Place, added: Added }),
  // A middleware the adapter did not recognise as an auth guard.
  z.object({ type: z.literal('guard'), scope: z.string().min(1), name: z.string().min(1), example: Place, added: Added }),
  // "Not a flow": a graph node left out of every scan.
  z.object({ type: z.literal('exclude'), node: z.string().min(1), added: Added }),
  // PLAN.md §4 Feedback on a flow (or one of its steps), from the review page or `flows review`. The judge applies
  // the latest correct, wrong or never ("never suggest again") at the next scan; the page shows the rest.
  z.object({
    type: z.literal('feedback'),
    flow: z.string().min(1),
    step: z.string().min(1).optional(),
    kind: z.enum(FEEDBACK_KINDS),
    comment: z.string().min(1).optional(),
    place: Place.optional(), // where a missing step is, when the reviewer knows
    added: Added,
  }),
  // PLAN.md Phase 3 inspector: a person's correction of what a live element is. On the page pattern, the element with
  // this selector is that source node, or (node: null) none; the cross-check and the inspector use it before guessing.
  z.object({ type: z.literal('match'), page: z.string().startsWith('/'), selector: z.string().min(1), node: z.string().min(1).nullable(), added: Added }),
  // Drafted from marked examples for code no adapter reads: every match becomes a route (api) or a page (web),
  // read from the pattern's metavariables.
  z.object({
    type: z.literal('generic'),
    produces: z.enum(['route', 'page']),
    rule: PatternRuleSchema,
    path: z.string().regex(/^\$[A-Z_][A-Z0-9_]*$/),
    method: z.string().min(1).optional(), // a metavariable ("$METHOD") or a fixed HTTP method
    examples: z.array(Place).min(1),
    added: Added,
  }),
]);

export type LearnedRule = z.infer<typeof LearnedRuleSchema>;
export type GenericRule = Extract<LearnedRule, { type: 'generic' }>;
export type Feedback = Extract<LearnedRule, { type: 'feedback' }>;
export type MatchRule = Extract<LearnedRule, { type: 'match' }>;

const RulesFileSchema = z.object({ schema_version: z.literal(0), rules: z.array(LearnedRuleSchema) });

export const rulesFile = (repoDir: string): string => join(repoDir, '.flows', 'rules.json');
export const today = (): string => new Date().toISOString().slice(0, 10);

// A broken rules file stops the scan with a message rather than being skipped: it is the user's own config.
export function loadRules(repoDir: string): LearnedRule[] {
  const file = rulesFile(repoDir);
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON`, { cause: error });
  }
  return parseOrThrow(RulesFileSchema, raw, file, ConfigError).rules;
}

export function addRule(repoDir: string, rule: LearnedRule): void {
  writeJsonAtomic(rulesFile(repoDir), { schema_version: 0, rules: [...loadRules(repoDir), LearnedRuleSchema.parse(rule)] }, 2);
}
