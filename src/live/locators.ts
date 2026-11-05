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

const ChecksSchema = z.record(z.string(), z.enum(['verified', 'ambiguous', 'missing']));
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

// What the runs saw of a control, on the pages matching `page` first and anywhere after that. An xpath is not a
// stable answer, so it never replaces what the code gave.
function seenField(runs: readonly Run[], page: string, name: string): Found | undefined {
  const states = runs.flatMap((run) => run.states);
  const here = pageRegex(page);
  for (const state of [...states.filter((s) => here.test(s.path)), ...states]) {
    const field = state.forms.flatMap((form) => form.fields).find((candidate) => candidate.name === name && candidate.selector !== '' && !candidate.selector.startsWith('xpath:'));
    if (field !== undefined) return { selector: field.selector };
  }
  return undefined;
}

function seenButton(runs: readonly Run[], page: string, text: string): Found | undefined {
  const states = runs.flatMap((run) => run.states);
  const here = pageRegex(page);
  const same = (candidate: string) => candidate.trim().toLowerCase() === text.trim().toLowerCase();
  for (const state of [...states.filter((s) => here.test(s.path)), ...states]) {
    const controls = [...state.forms.flatMap((form) => (form.submit === null ? [] : [form.submit])), ...state.buttons];
    const found = controls.find((control) => same(control.text) && !control.selector.startsWith('xpath:'));
    if (found !== undefined) return { selector: found.selector };
  }
  return undefined;
}

// A copy of the flows for a test tool: each action's selectors say how far to trust them, and with live runs each step
// says whether the running app showed it. A write is blocked for the explorer, so it reads "observed: false" unless a
// person did it by hand in the inspector.
export function annotate(flows: readonly Flow[], runs: readonly Run[], checks: Checks = {}): Flow[] {
  const requests = runs.flatMap((run) => run.requests);
  const states = runs.flatMap((run) => run.states);
  const actions = runs.flatMap((run) => run.actions);
  return withExamples(flows).map((flow) => {
    const pages = actionPages(flow);
    const steps = flow.steps.map((step): Step => {
      let out = step;
      if (step.action !== undefined) {
        const page = pages.get(step) ?? '/';
        const mark = (selector: string, found: Found | undefined): { selector: string; locator: Locator } => {
          const chosen = found === undefined ? selector : playwrightSelector(found.selector);
          const checked = checks[keyOf(page, chosen)];
          return { selector: chosen, locator: checked ?? (found === undefined ? 'source' : 'live') };
        };
        const action: Action = {
          ...step.action,
          fields: step.action.fields.map((field) => ({ ...field, ...mark(field.selector, seenField(runs, page, field.name)) })),
          ...(step.action.button === undefined ? {} : { button: { ...step.action.button, ...mark(step.action.button.selector, seenButton(runs, page, step.action.button.text)) } }),
        };
        out = { ...out, action };
      }
      if (runs.length > 0) out = { ...out, observed: observedStep(step, states, requests, actions) };
      return out;
    });
    return { ...flow, steps };
  });
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

export type Verified = { page: string; selector: string; result: Locator | 'skipped'; note?: string };

// Opens each page the flows act on with plain GETs (a read-only guard stands in front, as in the explorer) and counts
// the elements each exported selector finds. A page with a parameter, or one the app sent elsewhere (a login guard),
// is skipped, with the reason.
export async function verifyLocators(flows: readonly Flow[], base: URL, opts: { browser: string | undefined; storageState: string | undefined; safe: readonly string[] }): Promise<Verified[]> {
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
    for (const [path, selectors] of wanted) {
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
      for (const selector of selectors) {
        const count = await page.locator(selector).count().catch(() => 0);
        results.push({ page: path, selector, result: count === 1 ? 'verified' : count === 0 ? 'missing' : 'ambiguous' });
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

export const checksOf = (results: readonly Verified[]): Checks =>
  Object.fromEntries(results.flatMap((r) => (r.result === 'verified' || r.result === 'ambiguous' || r.result === 'missing' ? [[keyOf(r.page, r.selector), r.result] as const] : [])));
