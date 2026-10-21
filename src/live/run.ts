import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { projectDataDir, type Project } from '../config/project.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';

// One explorer or inspector run against the live app (PLAN.md Phase 3). It is a deletable cache, like the graphs:
// running explore again rebuilds it. Everything in it was redacted before it was written (redact.ts).

const ElementSchema = z.object({ text: z.string(), selector: z.string().min(1), stable: z.boolean() });
const FieldSchema = z.object({ name: z.string(), type: z.string(), label: z.string(), required: z.boolean(), visible: z.boolean(), selector: z.string(), options: z.array(z.string()) });

export const StateSchema = z.object({
  n: z.int().min(0),
  url: z.string().min(1),
  path: z.string().startsWith('/'),
  title: z.string(),
  text: z.string(),
  links: z.array(ElementSchema.extend({ href: z.string() })),
  buttons: z.array(ElementSchema.extend({ role: z.string(), form: z.int().nullable(), group: z.string().default(''), list: z.string().default('') })),
  forms: z.array(ElementSchema.extend({ method: z.string(), action: z.string(), fields: z.array(FieldSchema), submit: ElementSchema.nullable() })),
  shot: z.string().nullable(), // the screenshot's file name in the run folder
  from: z.object({ state: z.int(), action: z.int() }).nullable(), // the action that led here; null for a URL opened directly
  requested: z.string().nullable(), // the path asked for, when the app sent the browser elsewhere (a guard's redirect)
});

const ProbsSchema = z.record(z.string(), z.number());

export const ActionSchema = z.object({
  n: z.int().min(0),
  state: z.int().min(0),
  kind: z.enum(['link', 'click', 'submit']),
  element: ElementSchema,
  text: z.string(), // the Decider's one-line input
  fields: z.array(z.string()), // a submitted form's field names
  decision: z.object({ label: z.string(), prob: z.number(), probs: ProbsSchema, by: z.enum(['rule', 'decider']), reason: z.string() }),
  taken: z.boolean(),
  // What taking it did: the state it led to (a new page or dialog), the requests it made, and whether the page
  // changed at all (a flipped board, a copied link) even when neither of those happened.
  result: z.object({ state: z.int().nullable(), requests: z.array(z.int()), changed: z.boolean().default(false) }).nullable(),
});

export const RequestSchema = z.object({
  n: z.int().min(0),
  state: z.int().nullable(),
  action: z.int().nullable(),
  visit: z.int().nullable(), // each page load is a visit; polling repeats within one
  method: z.string().min(1),
  url: z.string(),
  origin: z.string(),
  path: z.string(),
  resource: z.string(),
  kind: z.enum(['page', 'api', 'asset', 'framework', 'realtime', 'external']),
  server_action: z.boolean(), // a Next.js server action (a POST to the page with a Next-Action header)
  status: z.int().nullable(),
  blocked: z.boolean(),
  failed: z.string().nullable(),
  shape: z.unknown().optional(), // a blocked write's body, as field types without values
  response: z.object({ type: z.string(), fields: z.array(z.string()), body: z.unknown() }).nullable(),
  noise: z.object({ label: z.enum(['noise', 'relevant']), by: z.enum(['rule', 'decider']), reason: z.string(), probs: ProbsSchema }).nullable(),
});

export const RunSchema = z.object({
  schema_version: z.literal(0),
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(['explorer', 'inspector']),
  url: z.string().min(1), // where it started, redacted
  origin: z.string().min(1),
  session: z.string().nullable(), // the login it ran as; null when signed out
  started: z.string(),
  finished: z.string(),
  browser: z.string(),
  flow: z.string().optional(), // a guided inspector walk: the flow it walked
  states: z.array(StateSchema),
  actions: z.array(ActionSchema),
  requests: z.array(RequestSchema),
  sockets: z.array(z.string()),
  notes: z.array(z.string()),
});

export type Run = z.infer<typeof RunSchema>;
export type State = z.infer<typeof StateSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type RequestRecord = z.infer<typeof RequestSchema>;

export const observedDir = (project: Project): string => join(projectDataDir(project), 'observed');
export const runDir = (project: Project, id: string): string => join(observedDir(project), id);

export const newRunId = (kind: Run['kind'], now = new Date()): string =>
  `${kind}-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;

// Every run with a readable run.json, oldest first. A folder without one is a run that never finished.
export function loadRuns(project: Project): Run[] {
  const dir = observedDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((id) => readCache(join(dir, id, 'run.json'), RunSchema) ?? [])
    .sort((a, b) => a.started.localeCompare(b.started));
}

const DAY = 24 * 60 * 60 * 1000;

// A new explorer run replaces the older ones for the same origin and login, so a re-run doesn't keep stale pages;
// inspector runs are a person's walks and stay. Folders of runs that never finished go once they are a day old (a
// younger one may still be running).
export function saveRun(project: Project, run: Run): void {
  writeJsonAtomic(join(runDir(project, run.id), 'run.json'), RunSchema.parse(run));
  const dir = observedDir(project);
  for (const id of readdirSync(dir)) {
    if (id === run.id) continue;
    const old = readCache(join(dir, id, 'run.json'), RunSchema);
    const replaced = old !== undefined && run.kind === 'explorer' && old.kind === 'explorer' && old.origin === run.origin && old.session === run.session;
    const abandoned = old === undefined && statSync(join(dir, id)).mtimeMs < Date.now() - DAY;
    if (replaced || abandoned) rmSync(join(dir, id), { recursive: true, force: true });
  }
}
