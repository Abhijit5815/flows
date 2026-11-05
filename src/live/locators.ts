import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { projectDataDir, type Project } from '../config/project.ts';
import { withExamples } from '../engine/examples.ts';
import type { Flow } from '../model/flow.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';
import { z } from 'zod';
import { launchBrowser, newContext } from './browser.ts';
import { pageRegex, routeRegex } from './paths.ts';
import { guardReadOnly } from './readonly.ts';
import type { Run } from './run.ts';

// How far a test can trust an exported selector. source: built from the code only. live: the explorer or inspector
// saw that control on the running app. verified: `flows verify-locators` found exactly one such element on its page.
// ambiguous: it found several (Playwright's strict mode would refuse). missing: the page loaded and it was not there.
export type Locator = 'verified' | 'live' | 'source' | 'ambiguous' | 'missing';

type Step = Flow['steps'][number];
type Action = NonNullable<Step['action']>;

// Flows' own selector format (snapshot.ts) as a Playwright selector string a test can pass to page.locator().
export function playwrightSelector(selector: string): string {
  const colon = selector.indexOf(':');
  const value = selector.slice(colon + 1);
  const quoted = JSON.stringify;
  switch (selector.slice(0, colon)) {
    case 'testid':
      return `[data-testid=${quoted(value)}]`;
    case 'attr': {
      const at = value.indexOf('=');
      return `[${value.slice(0, at)}=${quoted(value.slice(at + 1))}]`;
    }
    case 'id':
    case 'name':
      return `[${selector.slice(0, colon)}=${quoted(value)}]`;
    case 'role': {
      const space = value.indexOf(' ');
      return `role=${value.slice(0, space)}[name=${quoted(value.slice(space + 1).replace(/^"|"$/g, ''))}]`;
    }
    default:
      return `xpath=${value}`;
  }
}

// after: Playwright selectors to click, in order, before the element exists (a tab, a "Sign up with email" button).
const ChecksSchema = z.record(z.string(), z.object({ result: z.enum(['verified', 'ambiguous', 'missing']), after: z.array(z.string()).optional() }));
export type Checks = z.infer<typeof ChecksSchema>;

const checksFile = (project: Project): string => join(projectDataDir(project), 'locator-checks.json');
export const loadChecks = (project: Project): Checks => (existsSync(checksFile(project)) ? (readCache(checksFile(project), ChecksSchema) ?? {}) : {});
export const saveChecks = (project: Project, checks: Checks): void => writeJsonAtomic(checksFile(project), checks, 2);
const keyOf = (page: string, selector: string) => `${page} ${selector}`;

// The page each action step happens on: the last page its flow opened before it.
export function actionPages(flow: Flow): Map<Step, string> {
  const pages = new Map<Step, string>();
  let page: string | undefined;
  for (const step of flow.steps) {
    if (step.action !== undefined) {
      if (page !== undefined) pages.set(step, page);
    } else if (step.kind === 'ui' && step.check?.kind === 'ui' && step.check.page !== undefined) page = step.check.page;
  }
  return pages;
}

type Found = { selector: string };

// What the runs saw of a control, on the pages matching `page` and nowhere else (the same name on another page is another
// control: a signup's email field has a different test id than the login's). An xpath is not a
// stable answer, so it never replaces what the code gave.
function seenField(runs: readonly Run[], page: string, name: string): Found | undefined {
  const states = runs.flatMap((run) => run.states);
  const here = pageRegex(page);
  for (const state of states.filter((s) => here.test(s.path))) {
    const field = state.forms.flatMap((form) => form.fields).find((candidate) => candidate.name === name && candidate.selector !== '' && !candidate.selector.startsWith('xpath:'));
    if (field !== undefined) return { selector: field.selector };
  }
  return undefined;
}

function seenButton(runs: readonly Run[], page: string, text: string): Found | undefined {
  const states = runs.flatMap((run) => run.states);
  const here = pageRegex(page);
  const same = (candidate: string) => candidate.trim().toLowerCase() === text.trim().toLowerCase();
  for (const state of states.filter((s) => here.test(s.path))) {
    const controls = [...state.forms.flatMap((form) => (form.submit === null ? [] : [form.submit])), ...state.buttons];
    const found = controls.find((control) => same(control.text) && !control.selector.startsWith('xpath:'));
    if (found !== undefined) return { selector: found.selector };
  }
  return undefined;
}

// A copy of the flows for a test tool: each action's selectors say how far to trust them, and with live runs each step
// says whether the running app showed it. A write is blocked for the explorer, so it reads "observed: false" unless a
// person did it by hand in the inspector.
export function annotate(flows: readonly Flow[], runs: readonly Run[], checks: Checks = {}, prefix = ''): Flow[] {
  const base = withExamples(flows, prefix);
  const creates = new Map<string, NonNullable<NonNullable<Step['request']>['body']>>();
  const lists = new Set<string>();
  for (const flow of base) {
    for (const step of flow.steps) {
      if (step.request?.method === 'POST') creates.set(step.request.path, step.request.body ?? { schema: '', fields: [], evidence: [] });
      if (step.request?.method === 'GET') lists.add(step.request.path);
    }
  }
  return base.map((flow) => {
    const pages = actionPages(flow);
    const steps = flow.steps.map((step): Step => {
      let out = step;
      if (step.action !== undefined) {
        const page = pages.get(step) ?? '/';
        const mark = (selector: string, found: Found | undefined): { selector: string; locator: Locator; after?: string[] } => {
          const chosen = found === undefined ? selector : playwrightSelector(found.selector);
          const checked = checks[keyOf(page, chosen)];
          return { selector: chosen, locator: checked?.result ?? (found === undefined ? 'source' : 'live'), ...(checked?.after === undefined ? {} : { after: checked.after }) };
        };
        const action: Action = {
          ...step.action,
          fields: step.action.fields.map((field) => ({ ...field, ...mark(field.selector, seenField(runs, page, field.name)) })),
          ...(step.action.button === undefined ? {} : { button: { ...step.action.button, ...mark(step.action.button.selector, seenButton(runs, page, step.action.button.text)) } }),
        };
        out = { ...out, action };
      }
      if (runs.length > 0 && step.kind !== 'subflow') {
        const seen = runs.filter((run) => observedStep(step, run.states, run.requests, run.actions));
        out = { ...out, observed: seen.length > 0 };
        if (seen.length > 0) out = { ...out, observed_as: [...new Set(seen.map((run) => run.session ?? 'signed out'))] };
        const answer = step.kind === 'api' ? responseExample(step, seen) : undefined;
        if (answer !== undefined) out = { ...out, response_example: answer };
      }
      const setup = step.request === undefined ? [] : setupFor(step.request.path, creates, lists);
      if (setup.length > 0) out = { ...out, setup };
      return out;
    });
    return { ...flow, steps };
  });
}

// A real answer to this call, from the live runs that made it (redacted when recorded); not one past 4 KB.
function responseExample(step: Step, runs: readonly Run[]): unknown {
  const route = step.request === undefined ? undefined : routeRegex(step.request.path);
  for (const run of runs) {
    for (const request of run.requests) {
      if (request.kind !== 'api' || request.method !== step.request?.method || route?.test(request.path) !== true || request.blocked || request.status === null || request.status >= 300) continue;
      const body = request.response?.body;
      if (body !== undefined && body !== null && JSON.stringify(body).length <= 4000) return body;
    }
  }
  return undefined;
}

// For each :param in a path, how a test gets one: the route that creates the thing (POST on the path before the
// param) and the one that lists it, when the flows have them.
function setupFor(path: string, creates: ReadonlyMap<string, NonNullable<NonNullable<Step['request']>['body']>>, lists: ReadonlySet<string>): NonNullable<Step['setup']> {
  const out: NonNullable<Step['setup']> = [];
  const segments = path.split('/');
  segments.forEach((segment, i) => {
    if (!segment.startsWith(':')) return;
    const before = segments.slice(0, i).join('/');
    const body = creates.get(before);
    if (body === undefined && !lists.has(before)) return;
    out.push({ param: segment.slice(1), ...(body === undefined ? {} : { create: `POST ${before}`, ...(body.example === undefined ? {} : { body: body.example }) }), ...(lists.has(before) ? { list: `GET ${before}` } : {}) });
  });
  return out;
}

function observedStep(step: Step, states: Run['states'], requests: Run['requests'], actions: Run['actions']): boolean {
  if (step.kind === 'api' && step.request !== undefined) {
    const route = routeRegex(step.request.path);
    return requests.some((request) => request.kind === 'api' && request.method === step.request?.method && route.test(request.path) && !request.blocked && request.status !== null);
  }
  if (step.kind === 'ui' && step.action !== undefined) {
    const names = step.action.fields.map((field) => field.name);
    const text = step.action.button?.text.toLowerCase();
    return actions.some((action) => action.taken && (names.length > 0 ? names.every((name) => action.fields.includes(name)) : text !== undefined && action.element.text.toLowerCase() === text));
  }
  if (step.kind === 'ui' && step.check?.kind === 'ui' && step.check.page !== undefined) {
    const page = pageRegex(step.check.page);
    return states.some((state) => page.test(state.path));
  }
  return false;
}

export type Verified = { page: string; selector: string; result: Locator | 'skipped'; note?: string; after?: string[] };

// Controls a person would not press just to look: the search for what a click reveals never presses these.
const RISKY = /delete|remove|sign out|log ?out|pay|purchase|buy|block|report|cancel|unsubscribe|deactivate|submit|confirm|send|save/i;

// Opens each page the flows act on with plain GETs (a read-only guard stands in front, as in the explorer) and counts
// the elements each exported selector finds. A page with a parameter, or one the app sent elsewhere (a login guard),
// is skipped, with the reason.
export async function verifyLocators(flows: readonly Flow[], base: URL, opts: { browser: string | undefined; storageState: string | undefined; safe: readonly string[]; log?: (line: string) => void }): Promise<Verified[]> {
  const wanted = new Map<string, Set<string>>();
  for (const flow of flows) {
    for (const [step, page] of actionPages(flow)) {
      const set = wanted.get(page) ?? new Set<string>();
      for (const control of [...(step.action?.fields ?? []), ...(step.action?.button === undefined ? [] : [step.action.button])]) set.add(control.selector);
      wanted.set(page, set);
    }
  }
  const results: Verified[] = [];
  const { browser } = await launchBrowser(opts.browser, true);
  try {
    const context = await newContext(browser, opts.storageState);
    await guardReadOnly(context, opts.safe);
    const page: Page = await context.newPage();
    let done = 0;
    for (const [path, selectors] of wanted) {
      opts.log?.(`  ${++done}/${wanted.size} ${path}`);
      if (/[[:*]/.test(path)) {
        for (const selector of selectors) results.push({ page: path, selector, result: 'skipped', note: 'the page has a parameter' });
        continue;
      }
      try {
        await page.goto(new URL(path, base).href, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForTimeout(500);
      } catch (error) {
        for (const selector of selectors) results.push({ page: path, selector, result: 'skipped', note: `did not load: ${(error as Error).message.split('\n')[0]}` });
        continue;
      }
      const landed = new URL(page.url()).pathname;
      if (!pageRegex(path).test(landed)) {
        for (const selector of selectors) results.push({ page: path, selector, result: 'skipped', note: `the app sent it to ${landed}; try --as <login>` });
        continue;
      }
      const missing: string[] = [];
      for (const selector of selectors) {
        const count = await page.locator(`${selector} >> visible=true`).count().catch(() => 0);
        if (count === 0) missing.push(selector);
        else results.push({ page: path, selector, result: count === 1 ? 'verified' : 'ambiguous' });
      }
      // What is not there yet may be behind a tab or a first step: press each harmless button once, a click deep.
      for (const reveal of missing.length === 0 ? [] : await revealers(page)) {
        if (missing.length === 0) break;
        await page.locator(reveal).first().click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        for (const selector of [...missing]) {
          const count = await page.locator(`${selector} >> visible=true`).count().catch(() => 0);
          if (count === 0) continue;
          results.push({ page: path, selector, result: count === 1 ? 'verified' : 'ambiguous', after: [reveal] });
          missing.splice(missing.indexOf(selector), 1);
        }
        if (missing.length > 0) await page.goto(new URL(path, base).href, { waitUntil: 'load', timeout: 30_000 }).then(() => page.waitForTimeout(300)).catch(() => undefined);
      }
      for (const selector of missing) results.push({ page: path, selector, result: 'missing' });
    }
  } finally {
    await browser.close();
  }
  return results;
}

// Role selectors for the page's tabs and buttons that are safe to press, at most 25.
async function revealers(page: Page): Promise<string[]> {
  const found = await page
    .evaluate(() => [...document.querySelectorAll('button, [role=tab]')].filter((el) => (el as HTMLElement).checkVisibility?.() ?? true).map((el) => ({ role: el.getAttribute('role') ?? 'button', name: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() })))
    .catch(() => []);
  const unique = new Map(found.filter((c) => c.name !== '' && c.name.length < 60 && !RISKY.test(c.name)).map((c) => [`role=${c.role}[name=${JSON.stringify(c.name)}]`, c]));
  return [...unique.keys()].slice(0, 25);
}

export const checksOf = (results: readonly Verified[]): Checks =>
  Object.fromEntries(results.flatMap((r) => (r.result === 'verified' || r.result === 'ambiguous' || r.result === 'missing' ? [[keyOf(r.page, r.selector), { result: r.result, ...(r.after === undefined ? {} : { after: r.after }) }] as const] : [])));
