import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import type { ExplorerConfig } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { words } from '../engine/describe.ts';
import { LiveError } from '../shared/errors.ts';
import { launchBrowser, newContext } from './browser.ts';
import { captureState, markPolling, Recorder } from './capture.ts';
import type { GuidedStep, Knowing } from './know.ts';
import { callMatches } from './match.ts';
import { labelNoise, siteOf } from './noise.ts';
import { overlayScript } from './overlay.ts';
import { bestMatch, generalize, pageRegex } from './paths.ts';
import { redactUrl } from './redact.ts';
import { newRunId, type Action, type Run, type State } from './run.ts';

export type InspectInput = {
  url: string;
  session: string | null; // the login the browser starts with; null when signed out
  storageState: string | undefined;
  guided: { flow: string; steps: GuidedStep[] } | undefined; // a "Walk this in the inspector": the steps to tick
  headless: boolean; // only tests run it without a window
  person?: (page: Page) => Promise<void>; // tests: a scripted person; the walk ends when it returns
};

export type InspectDeps = { decider: Decider; config: ExplorerConfig; pages: readonly string[]; knowing: Knowing; runDir(id: string): string; log(line: string): void };

export type Walk = { run: Run; ticked: string[] };

const SETTLE = 500;
const ACTION_WINDOW = 2000; // requests this long after a click or submit are what it did

// What the page may send, checked at the edge: the binding is a door from the page into Flows.
const FactsSchema = z.object({
  path: z.string().startsWith('/').max(2000),
  tag: z.string().max(40),
  text: z.string().max(500),
  role: z.string().max(40),
  selector: z.string().min(1).max(2000),
  stable: z.boolean(),
  href: z.string().max(2000).nullable(),
  fields: z.array(z.string().max(200)).max(200),
  inForm: z.boolean(),
});
const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hover'), facts: FactsSchema }),
  z.object({ type: z.literal('click'), facts: FactsSchema }),
  z.object({ type: z.literal('submit'), facts: FactsSchema }),
  z.object({ type: z.literal('correct'), facts: FactsSchema, node: z.string().min(1).max(500).nullable() }),
  z.object({ type: z.literal('ticks') }),
  z.object({ type: z.literal('done') }),
]);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// PLAN.md Phase 3 inspector (optional, off by default): a visible browser in which the person uses the app by hand,
// for the flows the explorer can't reach (multi-step data entry, role-specific paths). Nothing is blocked: the person
// is the one acting, and their own data entry has to reach the app. What they do is recorded like an explorer run,
// redacted the same way, and goes through the same cross-check. Pointing at an element shows what source knows about
// it, and a correction is saved as a match rule. In guided mode the overlay ticks the flow's steps as they're done.
export async function inspect(input: InspectInput, deps: InspectDeps): Promise<Walk> {
  let start: URL;
  try {
    start = new URL(input.url);
  } catch {
    throw new LiveError(`"${input.url}" is not a URL`);
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') throw new LiveError(`"${input.url}" is not an http or https URL`);
  if (!input.headless && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new LiveError('the inspector needs a display to open its browser on');
  const id = newRunId('inspector');
  const dir = deps.runDir(id);
  mkdirSync(dir, { recursive: true });
  const started = new Date().toISOString();
  const token = randomBytes(16).toString('hex');
  const { browser, name } = await launchBrowser(deps.config.browser, input.headless);
  try {
    const context = await newContext(browser, input.storageState);
    const recorder = new Recorder(context, siteOf(start.hostname));
    const page = await context.newPage();
    const patternOf = (path: string) => bestMatch(path, deps.pages, pageRegex) ?? generalize(path);
    const states: State[] = [];
    const actions: Action[] = [];
    const ticked = new Set<string>();
    const steps = input.guided?.steps ?? [];
    const tick = (matches: (step: GuidedStep) => boolean) => {
      for (const step of steps) if (!ticked.has(step.id) && matches(step)) ticked.add(step.id);
    };
    if (input.session !== null) tick((step) => 'session' in step.target);

    // Every page load (and in-app navigation) is a state, captured once the page settles.
    let visits = 0;
    let capturing: Promise<void> = Promise.resolve();
    const capture = () => {
      capturing = capturing.then(async () => {
        await page.waitForLoadState('load').catch(() => undefined);
        await sleep(SETTLE);
        if (page.isClosed()) return;
        try {
          const { password: _, ...state } = await captureState(page, dir, states.length, null, null);
          states.push(state);
          Object.assign(recorder.where, { state: state.n, action: null, visit: visits++ });
          tick((step) => 'page' in step.target && patternOf(state.path) === step.target.page);
        } catch {
          // the page went away while it was being read; the next load is captured instead
        }
      });
      return capturing;
    };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) void capture();
    });

    // A click or submit the person made, with the requests that follow it.
    const open = new Map<Action, () => void>();
    const record = (kind: 'click' | 'submit', facts: z.infer<typeof FactsSchema>) => {
      const before = states.length;
      const action: Action = {
        n: actions.length,
        state: Math.max(before - 1, 0),
        kind,
        element: { text: facts.text, selector: facts.selector, stable: facts.stable },
        text: `${kind === 'submit' ? 'form' : 'click'}: ${words(facts.text) || 'button'} on ${patternOf(facts.path)}`,
        fields: facts.fields,
        decision: { label: 'person', prob: 1, probs: {}, by: 'rule', reason: 'done by a person in the inspector' },
        taken: true,
        result: null,
      };
      actions.push(action);
      recorder.where.action = action.n;
      const mark = recorder.requests.length;
      const close = () => {
        open.delete(action);
        action.result = { state: states.length > before ? states[before].n : null, requests: recorder.since(mark).map((request) => request.n), changed: true };
        if (recorder.where.action === action.n) recorder.where.action = null;
      };
      open.set(action, close);
      setTimeout(() => open.get(action)?.(), ACTION_WINDOW);
      if (kind === 'click' || kind === 'submit') {
        const known = deps.knowing.know(facts);
        tick((step) => 'node' in step.target && known.node?.id === step.target.node);
      }
    };

    let finish = () => undefined as void;
    const finished = new Promise<void>((done) => (finish = done));
    await page.exposeBinding('__flows', async (_source, raw: unknown) => {
      const event = EventSchema.safeParse(raw);
      if (!event.success || (raw as { token?: unknown }).token !== token) return undefined;
      switch (event.data.type) {
        case 'hover':
          return deps.knowing.know(event.data.facts);
        case 'click':
        case 'submit':
          record(event.data.type, event.data.facts);
          return true;
        case 'correct':
          deps.knowing.correct(event.data.facts, event.data.node);
          deps.log(`  corrected: ${event.data.facts.selector} on ${patternOf(event.data.facts.path)} is ${event.data.node ?? 'none of the source nodes'}`);
          return deps.knowing.know(event.data.facts);
        case 'ticks':
          tick((step) => 'call' in step.target && recorder.requests.some((request) => callMatches((step.target as { call: { method: string; path: string } }).call, request)));
          return [...ticked];
        case 'done':
          finish();
          return true;
      }
    });
    await context.addInitScript({ content: overlayScript({ steps: input.guided === undefined ? null : steps.map(({ id: step, claim }) => ({ id: step, claim })), token }) });
    page.on('close', () => finish());
    browser.on('disconnected', () => finish());
    await page.goto(start.href);
    if (input.person !== undefined) {
      await input.person(page);
      finish();
    } else deps.log(`  the inspector is open at ${start.href}: use the app, then press Done (or close the window)`);
    await finished;

    await capturing;
    for (const close of [...open.values()]) close();
    tick((step) => 'call' in step.target && recorder.requests.some((request) => callMatches((step.target as { call: { method: string; path: string } }).call, request)));
    await recorder.settled();
    markPolling(recorder.requests);
    await labelNoise(recorder.requests, deps.decider);
    const run: Run = {
      schema_version: 0,
      id,
      kind: 'inspector',
      url: redactUrl(start.href),
      origin: start.origin,
      session: input.session,
      started,
      finished: new Date().toISOString(),
      browser: name,
      ...(input.guided === undefined ? {} : { flow: input.guided.flow }),
      states,
      actions,
      requests: recorder.requests,
      sockets: [],
      notes: [],
    };
    return { run, ticked: steps.filter((step) => ticked.has(step.id)).map((step) => step.id) };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
