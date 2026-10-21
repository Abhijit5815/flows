import type { Decider } from '../decider/decider.ts';
import { words } from '../engine/describe.ts';
import type { Action, State } from './run.ts';
import type { SourceTexts } from './texts.ts';

// The explorer's fixed action set (PLAN.md Phase 3): open a link, click a button, fill in and submit a form.
export type Candidate = Pick<Action, 'kind' | 'element' | 'text' | 'fields'> & {
  rated: string[]; // what the gate rates: the matched source flows' texts, or else the live text
  key: string; // the same control on another page (a header link, a shared form) is one action, decided once
  href?: string; // links: where it goes
  form?: number; // submits: the form's index in the state
};

// Ends the session the explorer is using, so it is never clicked, whatever the Decider says.
const SIGN_OUT = /\b(log ?out|sign ?out|logout|signout)\b/i;

// Look-alike controls are one action, explored once: the same text in the same structure (a "Join" on every row), or
// this many items of one table or list whatever they say (the moves of a game).
const ROW = 5;

// Each control on the page as a candidate action, with the one-line text the Decider rates, in the format of its
// examples: "click: add to cart on /products", "form: save (name, email) on /account", and for a link
// "click: orders -> GET /account/orders on /account".
export function candidatesOf(state: State, origin: string, patternOf: (path: string) => string, source?: SourceTexts): Candidate[] {
  const page = patternOf(state.path);
  const found: Candidate[] = [];
  const rated = (live: string, matched: readonly string[] | undefined) => (matched !== undefined && matched.length > 0 ? [...matched] : [live]);
  for (const link of state.links) {
    let target: URL;
    try {
      target = new URL(link.href);
    } catch {
      continue;
    }
    const to = target.origin === origin ? patternOf(target.pathname) : target.href;
    const text = `click: ${words(link.text) || 'link'} -> GET ${to} on ${page}`;
    found.push({ kind: 'link', element: link, text, rated: rated(text, target.origin === origin ? source?.link(to) : []), fields: [], key: `link ${target.origin === origin ? to : target.href}`, href: link.href });
  }
  state.forms.forEach((form, index) => {
    const fields = form.fields.filter((field) => field.type !== 'hidden' && field.name !== '').map((field) => field.name);
    const label = words(form.submit?.text ?? form.text) || 'form';
    const text = `form: ${label} (${fields.map(words).join(', ')}) on ${page}`;
    found.push({ kind: 'submit', element: form.submit ?? form, text, rated: rated(text, source?.form(page, fields, form.submit?.text ?? form.text)), fields, key: `form ${label} (${[...fields].sort().join(',')})`, form: index });
  });
  const lists = new Map<string, number>();
  for (const button of state.buttons) if (button.list !== '') lists.set(button.list, (lists.get(button.list) ?? 0) + 1);
  for (const button of state.buttons) {
    // A form's submit button is its submit action, already listed.
    if (button.form !== null && state.forms[button.form]?.submit?.selector === button.selector) continue;
    const listed = /\/(tr|td|th|li)(\/|$)/.test(button.list) && (lists.get(button.list) ?? 0) >= ROW;
    const key = listed ? `click list ${button.list}` : button.group === '' ? `click ${button.text} ${button.selector}` : `click ${button.group} ${button.text}`;
    const text = `click: ${words(button.text) || 'button'} on ${page}`;
    found.push({ kind: 'click', element: button, text, rated: rated(text, source?.click(page, button.text)), fields: [], key });
  }
  return found;
}

export type Gate = { decider: Decider; minSafeProb: number; origin: string };

type Decision = Action['decision'];
const rule = (reason: string): Decision => ({ label: 'skip', prob: 1, probs: {}, by: 'rule', reason });

// PLAN.md Phase 3: rules first, then the destructive-risk Decider. Only "safe" at or above explorer.min_safe_prob is
// taken. "destructive", "unknown" and a less sure "safe" are never clicked: when unsure, the action counts as
// destructive.
export async function gate(candidate: Candidate, state: State, deps: Gate): Promise<{ decision: Decision; taken: boolean }> {
  if (candidate.href !== undefined) {
    const target = new URL(candidate.href);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return { decision: rule(`a ${target.protocol} link, not a page`), taken: false };
    if (target.origin !== deps.origin) return { decision: rule('it leads to another site'), taken: false };
  }
  if (SIGN_OUT.test(candidate.element.text) || (candidate.href !== undefined && SIGN_OUT.test(new URL(candidate.href).pathname))) return { decision: rule('it would end the session'), taken: false };
  const form = candidate.form === undefined ? undefined : state.forms[candidate.form];
  if (form?.fields.some((field) => field.type === 'password')) return { decision: rule('it asks for a password'), taken: false };
  if (form?.fields.some((field) => field.type === 'file')) return { decision: rule('it uploads a file'), taken: false };

  // Every text the control stands for must be safe: the least safe one decides.
  let risk: Awaited<ReturnType<Decider['decide']>> | undefined;
  let rated = candidate.rated[0];
  for (const text of candidate.rated) {
    const decision = await deps.decider.decide('destructive-risk', text, ['destructive', 'safe']);
    const safety = (decision: { label: string; prob: number }) => (decision.label === 'safe' ? decision.prob : 0);
    if (risk === undefined || safety(decision) < safety(risk)) {
      risk = decision;
      rated = text;
    }
  }
  if (risk === undefined) return { decision: rule('nothing to rate'), taken: false }; // a bug: every candidate has a text
  const p = risk.prob.toFixed(2);
  const from = rated === candidate.text ? '' : ` (as the source flow "${rated}")`;
  const reason =
    risk.label === 'destructive'
      ? `rated destructive (p=${p})${from}`
      : risk.label === 'safe'
        ? risk.prob >= deps.minSafeProb
          ? `rated safe (p=${p})${from}`
          : `rated safe, but only p=${p}, below explorer.min_safe_prob ${deps.minSafeProb}${from}`
        : `the Decider was unsure${from}`;
  return { decision: { label: risk.label, prob: risk.prob, probs: risk.all_probs, by: 'decider', reason }, taken: risk.label === 'safe' && risk.prob >= deps.minSafeProb };
}
