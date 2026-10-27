import { flowId, numbered, type DraftStep } from '../engine/candidates.ts';
import { pageTitle, pressing, userCan, words } from '../engine/describe.ts';
import { FALLBACK_CATEGORY_ID } from '../model/category.ts';
import { HTTP_METHODS, type Flow } from '../model/flow.ts';
import type { Run } from './run.ts';

// PLAN.md Phase 3: the live app's own flows, built from what the runs saw, deterministically and in the shapes of
// the source flows (a page view with its load calls, a click or a form with the calls it made, one API call), so
// the cross-check can compare them. Candidate flows are tagged origin: observed.

type Method = (typeof HTTP_METHODS)[number];

// Evidence refs point into a run, by id: "<run>#s3" a page state, "<run>#a7 <selector>" an action's element,
// "<run>#r12" a request, "<run>#s3.jpg" a screenshot. The selector's kind shows whether it is stable (snapshot.ts).
export const stateRef = (run: string, state: number) => `${run}#s${state}`;
export const actionRef = (run: string, action: number, selector: string) => `${run}#a${action} ${selector}`;
export const requestRef = (run: string, request: number) => `${run}#r${request}`;
export const shotRef = (run: string, state: number) => `${run}#s${state}.jpg`;

const REF = /^([a-z0-9-]+)#([sar])(\d+)(\.jpg)?(?: .*)?$/;

export type Ref = { run: string; kind: 's' | 'a' | 'r'; n: number; shot: boolean };

export function parseRef(ref: string): Ref | undefined {
  const match = REF.exec(ref);
  if (match === null || (match[4] !== undefined && match[2] !== 's')) return undefined;
  return { run: match[1], kind: match[2] as Ref['kind'], n: Number(match[3]), shot: match[4] !== undefined }; // safe: the pattern allows only s, a and r
}

// The run item a ref names, if that run has it: the observed flows' verifier, like source claims against the graph.
export function resolves(ref: string, runs: ReadonlyMap<string, Run>): boolean {
  const parsed = parseRef(ref);
  const run = parsed === undefined ? undefined : runs.get(parsed.run);
  if (parsed === undefined || run === undefined) return false;
  if (parsed.kind === 's') return run.states[parsed.n] !== undefined && (!parsed.shot || run.states[parsed.n].shot !== null);
  return (parsed.kind === 'a' ? run.actions[parsed.n] : run.requests[parsed.n]) !== undefined;
}

export const isUnstable = (ref: string): boolean => / xpath:/.test(ref);

// noise: the call is kept for matching (a polled endpoint source declares is still confirmed by it) but never becomes
// a step of an observed flow, nor an observed-only flow.
export type Call = { method: Method; path: string; pattern: string; blocked: boolean; status: number | null; serverAction: boolean; fields: string[]; noise: boolean; ref: string };

// One observed flow and the facts the cross-check matches on.
export type Seen = {
  flow: Flow;
  run: string;
  page: { path: string; pattern: string; state: number; redirectedFrom: string | null } | undefined; // UI flows
  act: { kind: 'click' | 'submit'; text: string; fields: string[]; selector: string; ref: string } | undefined; // a click or a form
  calls: Call[]; // a UI flow's calls; an API flow's one call
  text: string; // the Decider's one-line input, in the format of its examples
  noise: boolean; // an API flow of a noise call: it can confirm a source route, but is never observed-only
};

// The forms and controls one page state showed: a source flow's visible elements can be confirmed from these even when
// the explorer didn't take them (a destructive form it never submits).
export type Shown = { ref: string; pattern: string; forms: { text: string; fields: string[]; selector: string }[]; buttons: { text: string; fields: string[]; selector: string }[] };

export function shownControls(runs: readonly Run[], patterns: Patterns): Shown[] {
  return runs.flatMap((run) =>
    run.states.map((state) => ({
      ref: stateRef(run.id, state.n),
      pattern: patterns.page(state.path),
      forms: state.forms.map((form) => ({ text: form.submit?.text ?? form.text, fields: form.fields.filter((field) => field.type !== 'hidden' && field.name !== '').map((field) => field.name), selector: form.submit?.selector ?? form.selector })),
      buttons: state.buttons.map((button) => ({ text: button.text, fields: [], selector: button.selector })),
    })),
  );
}

// A click or form the explorer saw and didn't take, with why: the cross-check says so instead of "not observed".
export type Skipped = { run: string; pattern: string; kind: 'click' | 'submit'; text: string; fields: string[]; selector: string; reason: string };

export type Patterns = { page(path: string): string; route(path: string): string };

const isMethod = (method: string): method is Method => (HTTP_METHODS as readonly string[]).includes(method);

function observedFlow(kind: Flow['kind'], key: string, name: string, steps: DraftStep[]): Flow {
  return {
    schema_version: 0,
    id: flowId(kind, `observed|${key}`),
    name,
    category: FALLBACK_CATEGORY_ID,
    kind,
    origin: 'observed',
    status: 'observed-only',
    confidence: 0,
    enabled: false,
    destructive: 'unknown',
    priority: 'medium',
    tags: [],
    version: 1,
    steps: numbered(steps),
  };
}

const callStep = (call: Call): DraftStep => ({
  kind: 'api',
  claim: `Calls ${call.method} ${call.pattern}${call.blocked ? ' (blocked by the read-only explorer)' : ''}`,
  request: { method: call.method, path: call.pattern },
  evidence: [{ type: 'network', ref: call.ref }],
  check: call.status === null ? null : { kind: 'api', status: call.status, ...(call.fields.length > 0 ? { fields: call.fields } : {}), evidence: [{ type: 'network', ref: call.ref }] },
  enabled: true,
});

// The app's own calls, once per method and pattern; blocked writes are kept, since what a UI action does is the call
// it makes, answered or not.
function callsOf(run: Run, numbers: readonly number[], patterns: Patterns): Call[] {
  const seen = new Map<string, Call>();
  for (const n of numbers) {
    const request = run.requests[n];
    // OPTIONS is the browser's own CORS preflight, not a call the app makes.
    if (request === undefined || request.kind !== 'api' || request.method === 'OPTIONS' || !isMethod(request.method)) continue;
    const pattern = patterns.route(request.path);
    const key = `${request.method} ${pattern}`;
    if (seen.has(key)) continue;
    seen.set(key, { method: request.method, path: request.path, pattern, blocked: request.blocked, status: request.status, serverAction: request.server_action, fields: request.response?.fields ?? [], noise: request.noise?.label === 'noise', ref: requestRef(run.id, n) });
  }
  return [...seen.values()];
}

const real = (list: readonly Call[]) => list.filter((call) => !call.noise);
const calls = (list: readonly Call[]) => (real(list).length === 0 ? '' : ` -> ${real(list).map((call) => `${call.method} ${call.pattern}`).join(', ')}`);

// What the runs saw and didn't do.
export function skippedActs(runs: readonly Run[], patterns: Patterns): Skipped[] {
  return runs.flatMap((run) =>
    run.actions.flatMap((action) =>
      action.taken || action.kind === 'link' ? [] : [{ run: run.id, pattern: patterns.page(run.states[action.state]?.path ?? '/'), kind: action.kind, text: action.element.text, fields: action.fields, selector: action.element.selector, reason: action.decision.reason }],
    ),
  );
}

// Every observed flow in the runs, newest run first, one per id.
export function observedFlows(runs: readonly Run[], patterns: Patterns): Seen[] {
  const found = new Map<string, Seen>();
  // One per id; a page shown directly beats the same page reached by a guard's redirect.
  const add = (seen: Seen) => {
    const kept = found.get(seen.flow.id);
    if (kept === undefined || (kept.page?.redirectedFrom != null && seen.page?.redirectedFrom == null)) found.set(seen.flow.id, seen);
  };
  const loginViews: Seen[] = [];
  for (const run of [...runs].sort((a, b) => b.started.localeCompare(a.started))) {
    for (const state of run.states) {
      const pattern = patterns.page(state.path);
      const loads = callsOf(
        run,
        run.requests.filter((request) => request.state === state.n && request.action === null).map((request) => request.n),
        patterns,
      );
      const open: DraftStep = {
        kind: 'ui',
        claim: `Open ${pattern}`,
        evidence: [{ type: 'dom', ref: stateRef(run.id, state.n) }, ...(state.shot === null ? [] : [{ type: 'screenshot' as const, ref: shotRef(run.id, state.n) }])],
        check: { kind: 'ui', page: pattern, evidence: [{ type: 'dom', ref: stateRef(run.id, state.n) }] },
        enabled: true,
      };
      const page = { path: state.path, pattern, state: state.n, redirectedFrom: state.requested };
      // A state a click opened (a dialog) is that click's result, not a page of its own. The login form's state is a
      // page view only when no other state shows that page (it may be the start page with a login dialog open).
      const login = run.actions.some((action) => action.state === state.n && action.decision.label === 'login');
      // A click that went to another page (a button that navigates) opened a page, not a dialog.
      const via = state.from === null ? undefined : run.actions[state.from.action];
      if (via === undefined || via.kind === 'link' || run.states[via.state]?.path !== state.path) {
        const view: Seen = { flow: observedFlow('ui', `open|${pattern}`, userCan(`view ${pageTitle(pattern)}`), [open, ...real(loads).map(callStep)]), run: run.id, page, act: undefined, calls: loads, text: `page: ${pattern}${calls(loads)}`, noise: false };
        if (login) loginViews.push(view);
        else add(view);
      }
      for (const action of run.actions) {
        if (action.state !== state.n || !action.taken || action.kind === 'link' || action.result === null) continue;
        const made = callsOf(run, action.result.requests, patterns);
        if (real(made).length === 0 && action.result.state === null && !action.result.changed) continue; // it did nothing the explorer could see
        const ref = actionRef(run.id, action.n, action.element.selector);
        const label = action.element.text || 'an unlabeled control';
        const act: DraftStep =
          action.kind === 'click'
            ? { kind: 'ui', claim: `Click "${label}"`, evidence: [{ type: 'dom', ref }], check: null, enabled: true }
            : { kind: 'ui', claim: `Fill in and submit the form (${action.fields.join(', ')}) with "${label}"`, evidence: [{ type: 'dom', ref }], check: null, enabled: true };
        const name = userCan(action.element.text ? pressing(action.element.text) : action.kind === 'click' ? 'use an unlabeled control' : 'submit a form');
        const text = action.kind === 'click' ? `click: ${words(label)}${calls(made)} on ${pattern}` : `form: ${words(label)} (${action.fields.map(words).join(', ')})${calls(made)} on ${pattern}`;
        add({
          flow: observedFlow('ui', `${action.kind}|${pattern}|${label}|${[...action.fields].sort().join(',')}`, name, [open, act, ...real(made).map(callStep)]),
          run: run.id,
          page,
          act: { kind: action.kind, text: label, fields: action.fields, selector: action.element.selector, ref },
          calls: made,
          text,
          noise: false,
        });
      }
    }
    // API flows: each answered call of the app's own, once per method and pattern. A blocked write was never
    // answered, so it says nothing about the backend. A noise call is kept to match on, never shown on its own.
    for (const call of callsOf(
      run,
      run.requests.filter((request) => request.status !== null).map((request) => request.n),
      patterns,
    )) {
      add({ flow: observedFlow('api', `${call.method} ${call.pattern}`, `${call.method} ${call.pattern}`, [{ ...callStep(call), claim: `Call ${call.method} ${call.pattern}` }]), run: run.id, page: undefined, act: undefined, calls: [call], text: `${call.method} ${call.pattern}`, noise: call.noise });
    }
  }
  for (const view of loginViews) add(view);
  return [...found.values()];
}
