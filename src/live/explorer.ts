import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
import type { ExplorerConfig } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import type { OptionalLlm } from '../engine/llm.ts';
import { LiveError } from '../shared/errors.ts';
import { candidatesOf, gate } from './actions.ts';
import { launchBrowser, newContext } from './browser.ts';
import { captureState, look, markPolling, Recorder } from './capture.ts';
import { fillForm } from './forms.ts';
import { locate } from './locate.ts';
import { loginWithEnv, saveSession, type Credentials } from './login.ts';
import { labelNoise, siteOf } from './noise.ts';
import { bestMatch, generalize, pageRegex } from './paths.ts';
import { guardReadOnly } from './readonly.ts';
import { redactPath, redactUrl } from './redact.ts';
import { newRunId, type Action, type Run, type State } from './run.ts';
import type { Snapshot } from './snapshot.ts';
import type { SourceTexts } from './texts.ts';

export type ExploreInput = {
  url: string;
  session: string | null; // the login it runs as, by name; null when signed out
  storageState: string | undefined; // a saved session to start from
  credentials: Credentials | undefined; // env credentials to log in with first
  saveSessionTo: string | undefined; // where an env login's session is kept for the next run
  pages: readonly string[]; // the web repos' page patterns, so /user/ana and /user/bo are one page
  source?: SourceTexts; // what the gate rates for a control that matches source (texts.ts)
  headless: boolean;
};

export type ExploreDeps = { decider: Decider; llm: OptionalLlm; config: ExplorerConfig; runDir(id: string): string; log(line: string): void };

const FIRST_DWELL = 1500; // the first load of a page is watched this long, so polling shows (three repeats)
const QUIET = 500; // a page has settled when no request started for this long
const MAX_SETTLE = 4000;
const STEP_TIMEOUT = 5000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// What the page shows, in one number: its URL, its visible text and its theme, so a click that changes any of them
// is seen to do something.
const fingerprint = (page: Page) =>
  page
    .evaluate(() => {
      const shown = `${location.href}|${document.documentElement.className}|${document.documentElement.dataset.theme ?? ''}|${document.body?.innerText ?? ''}`;
      let hash = 5381;
      for (let i = 0; i < shown.length; i++) hash = (hash * 33) ^ shown.charCodeAt(i);
      return hash >>> 0;
    })
    .catch(() => -1);

// A state is the same when its page pattern and the controls it shows are the same: a modal that opens is a new state.
const signature = (pattern: string, seen: Snapshot) =>
  JSON.stringify([pattern, seen.links.map((link) => `${link.text}>${link.href}`).sort(), seen.buttons.map((button) => button.text).sort(), seen.forms.map((form) => form.fields.map((field) => field.name).sort())]);

// A queued visit: a URL to open, then the actions to repeat on it; the last one is the action being explored.
type Visit = { url: string; steps: number[]; from: State['from'] };

// PLAN.md Phase 3 explorer: starts at the URL and goes breadth-first through the page states it can reach, by the
// fixed action set and within the budget (explorer.max_pages states, explorer.max_depth actions from a URL). It stays
// on the URL's origin, explores one page per page pattern, and decides every action through the gate (actions.ts).
// Writes never reach the app (readonly.ts). What it saw is returned as a run, redacted, with a screenshot per state.
export async function explore(input: ExploreInput, deps: ExploreDeps): Promise<Run> {
  let start: URL;
  try {
    start = new URL(input.url);
  } catch {
    throw new LiveError(`"${input.url}" is not a URL`);
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') throw new LiveError(`"${input.url}" is not an http or https URL`);
  const id = newRunId('explorer');
  const dir = deps.runDir(id);
  mkdirSync(dir, { recursive: true });
  const started = new Date().toISOString();
  const { browser, name } = await launchBrowser(deps.config.browser, input.headless);
  const notes: string[] = [];
  try {
    const context = await newContext(browser, input.storageState);
    const guard = await guardReadOnly(context);
    const recorder = new Recorder(context, siteOf(start.hostname), guard);
    const page = await context.newPage();
    context.on('page', (other) => {
      if (other !== page) void other.close(); // popups: the explorer stays in one tab
    });

    // Quiet is counted from the action too, so a click that starts no request still gets time to show its effect (a
    // menu that fades in).
    const settle = async (dwell = 0) => {
      const from = Date.now();
      await page.waitForLoadState('load', { timeout: MAX_SETTLE }).catch(() => undefined);
      while (Date.now() - from < MAX_SETTLE) {
        if (Date.now() - from >= dwell && Date.now() - Math.max(from, recorder.lastRequestAt) >= QUIET) break;
        await sleep(100);
      }
    };
    let visits = 0;
    const where = (state: number | null, action: number | null) => Object.assign(recorder.where, { state, action });
    const newVisit = () => (recorder.where.visit = visits++);

    const patternOf = (path: string) => bestMatch(path, input.pages, pageRegex) ?? generalize(path);
    const states: State[] = [];
    const actions: Action[] = [];

    // The login with env credentials is recorded like a form the explorer submitted, so it can confirm a Login flow.
    if (input.credentials !== undefined) {
      newVisit();
      where(states.length, null);
      let login: Action | undefined;
      let mark = 0;
      await loginWithEnv(page, guard, input.credentials, start, () => settle(), async () => {
        const { password: _, ...state } = await captureState(page, dir, states.length, null, null);
        states.push(state);
        const form = state.forms.find((candidate) => candidate.fields.some((field) => field.type === 'password'));
        if (form === undefined) return;
        const fields = form.fields.filter((field) => field.type !== 'hidden' && field.name !== '').map((field) => field.name);
        login = {
          n: actions.length,
          state: state.n,
          kind: 'submit',
          element: form.submit ?? form,
          text: `form: log in (${fields.join(', ')}) on ${patternOf(state.path)}`,
          fields,
          decision: { label: 'login', prob: 1, probs: {}, by: 'rule', reason: `the login, with the env credentials of explorer.logins.${input.session}` },
          taken: true,
          result: null,
        };
        actions.push(login);
        where(state.n, login.n);
        mark = recorder.requests.length;
      });
      if (login !== undefined) login.result = { state: null, requests: recorder.since(mark).map((request) => request.n), changed: true };
      if (input.saveSessionTo !== undefined) await saveSession(context, input.saveSessionTo);
      deps.log(`  logged in as ${input.session}`);
    }
    const known = new Map<string, number>(); // state signature -> state
    const decided = new Set<string>(); // action keys
    const statusBefore = new Map<string, number>(); // "GET /path" -> the last status seen, to notice a lost session
    const queue: Visit[] = [{ url: start.href, steps: [], from: null }];

    // Opens a visit's URL and repeats its steps; the last step is the action being explored. Requests are tagged with
    // the state they belong to: a link's page load with the new state, a repeated step with the state it was taken on.
    // `mark` is where the explored action's own requests begin.
    const reach = async (visit: Visit): Promise<{ ok: true; mark: number; changed: boolean } | { ok: false; why: string }> => {
      const first = visit.steps[0];
      where(first === undefined ? states.length : actions[first].state, null);
      newVisit();
      const mark = recorder.requests.length;
      const response = await page.goto(visit.url, { timeout: 15_000 }).catch((error: Error) => error);
      if (response instanceof Error) return { ok: false, why: response.message.split('\n')[0] };
      await settle(visit.steps.length === 0 ? FIRST_DWELL : 0);
      for (const [i, step] of visit.steps.entries()) {
        const action = actions[step];
        const last = i === visit.steps.length - 1;
        const before = recorder.requests.length;
        const shown = last ? await fingerprint(page) : 0;
        if (last) where(action.state, action.n);
        const done = await perform(page, action, states[action.state], deps.llm);
        if (!done.ok) return { ok: false, why: `couldn't repeat "${action.element.text}": ${done.why}` };
        await settle();
        if (last) return { ok: true, mark: before, changed: shown !== (await fingerprint(page)) };
      }
      return { ok: true, mark, changed: true };
    };

    const byPattern = new Map<string, number>(); // page pattern -> the state explored for it
    while (queue.length > 0 && states.length < deps.config.max_pages) {
      const visit = queue.shift() as Visit; // safe: the queue is not empty
      const asked = new URL(visit.url);
      const action = visit.from === null ? undefined : actions[visit.from.action];
      const askedPattern = patternOf(redactPath(asked.pathname));
      if (visit.steps.length === 0 && action !== undefined && byPattern.has(askedPattern)) {
        action.result = { state: byPattern.get(askedPattern) ?? null, requests: [], changed: true }; // one page per pattern
        continue;
      }
      const reached = await reach(visit);
      if (!reached.ok) {
        notes.push(`${redactUrl(visit.url)}: ${reached.why}`);
        continue;
      }
      const mine = recorder.since(reached.mark);
      if (action !== undefined) action.result = { state: null, requests: mine.map((request) => request.n), changed: reached.changed };
      if (page.url().startsWith('chrome-error://')) continue; // a blocked form post: nothing to see
      const here = new URL(page.url());
      if (here.origin !== start.origin) {
        notes.push(`${redactUrl(visit.url)} led to another site (${here.origin}); not followed`);
        continue;
      }
      // After a submit, or a click that tried to write, what shows is an error or the same page, not a new state,
      // unless the browser went to another page (a GET form's results, say).
      const navigated = visit.steps.length === 0 || `${here.pathname}${here.search}` !== `${asked.pathname}${asked.search}`;
      if (action !== undefined && action.kind !== 'link' && !navigated && (action.kind === 'submit' || mine.some((request) => request.blocked))) continue;

      const seen = await look(page);
      const path = redactPath(here.pathname);
      const key = signature(patternOf(path), seen);
      const existing = known.get(key);
      if (existing !== undefined) {
        if (action !== undefined) action.result = { state: existing, requests: mine.map((request) => request.n), changed: reached.changed };
        for (const request of mine) if (request.state === states.length) request.state = existing;
        continue;
      }
      const requestedPath = redactPath(asked.pathname);
      const redirected = visit.steps.length === 0 && requestedPath !== path ? requestedPath : null;
      const { password, ...state } = await captureState(page, dir, states.length, visit.from, redirected, seen);
      states.push(state);
      known.set(key, state.n);
      if (!byPattern.has(patternOf(path))) byPattern.set(patternOf(path), state.n);
      if (redirected !== null && !byPattern.has(askedPattern)) byPattern.set(askedPattern, state.n);
      if (action !== undefined) action.result = { state: state.n, requests: mine.map((request) => request.n), changed: true };

      // A signed-in run that is sent to a password page, or gets a 401 where it got a 200, has lost its session.
      if (input.session !== null && password && redirected !== null) throw new LiveError(`the session "${input.session}" seems to have ended: ${redirected} sent the browser to ${path}, which asks for a password; log in again`);
      for (const request of mine) {
        if (request.status === null || request.method !== 'GET') continue;
        const call = `${request.method} ${request.path}`;
        if (input.session !== null && request.status === 401 && statusBefore.get(call) === 200) throw new LiveError(`the session "${input.session}" seems to have ended: ${call} answered 401 after answering 200; log in again`);
        statusBefore.set(call, request.status);
      }

      for (const candidate of candidatesOf(state, start.origin, patternOf, input.source)) {
        if (decided.has(candidate.key)) continue;
        decided.add(candidate.key);
        const { decision, taken } = await gate(candidate, state, { decider: deps.decider, minSafeProb: deps.config.min_safe_prob, origin: start.origin });
        const next: Action = { n: actions.length, state: state.n, kind: candidate.kind, element: candidate.element, text: candidate.rated.join(' | '), fields: candidate.fields, decision, taken, result: null };
        actions.push(next);
        if (!taken) continue;
        // A state the browser navigated to (a link, or a click that changed the page) is reached again by its own URL;
        // a dialog by repeating the clicks that opened it.
        const base = navigated ? { url: page.url(), steps: [] } : { url: visit.url, steps: visit.steps };
        if (candidate.kind === 'link' && candidate.href !== undefined) queue.push({ url: candidate.href, steps: [], from: { state: state.n, action: next.n } });
        else if (base.steps.length < deps.config.max_depth) queue.push({ url: base.url, steps: [...base.steps, next.n], from: { state: state.n, action: next.n } });
        else notes.push(`"${next.element.text}" on ${path} is deeper than explorer.max_depth (${deps.config.max_depth}); not explored`);
      }
      deps.log(`  ${state.n + 1}. ${path}${redirected === null ? '' : ` (asked for ${redirected})`}: ${state.links.length} links, ${state.buttons.length} buttons, ${state.forms.length} forms`);
    }
    if (queue.length > 0) notes.push(`stopped at explorer.max_pages (${deps.config.max_pages}); ${queue.length} actions were not explored`);

    // The page keeps polling until the browser closes, so the run keeps the requests made while exploring; a call
    // recorded during the rating below would come out unrated.
    const requests = recorder.requests.slice();
    await recorder.settled();
    markPolling(requests);
    await labelNoise(requests, deps.decider);
    return {
      schema_version: 0,
      id,
      kind: 'explorer',
      url: redactUrl(start.href),
      origin: start.origin,
      session: input.session,
      started,
      finished: new Date().toISOString(),
      browser: name,
      states,
      actions,
      requests,
      sockets: [...new Set(guard.sockets)],
      notes,
    };
  } finally {
    await browser.close();
  }
}

// Performs one action on the page as it is now: follows a link, clicks a control, or fills in and submits a form.
async function perform(page: Page, action: Action, state: State, llm: OptionalLlm): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    if (action.kind === 'submit') {
      const form = state.forms.find((candidate) => candidate.submit?.selector === action.element.selector || candidate.selector === action.element.selector);
      if (form === undefined) return { ok: false, why: 'its form is gone' };
      const element = locate(page, form.selector);
      const filled = await fillForm(element, form.fields, llm);
      if (!filled.ok) return { ok: false, why: filled.reason };
      if (form.submit !== null) await locate(page, form.submit.selector).click({ timeout: STEP_TIMEOUT });
      else await element.evaluate((node) => (node as HTMLFormElement).requestSubmit());
      return { ok: true };
    }
    await locate(page, action.element.selector).click({ timeout: STEP_TIMEOUT });
    return { ok: true };
  } catch (error) {
    return { ok: false, why: (error as Error).message.split('\n')[0] };
  }
}
