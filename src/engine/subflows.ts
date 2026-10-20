import type { Lookup } from '../graph/lookup.ts';
import type { GraphNode } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';
import { numbered, template } from './candidates.ts';
import { evidenceOf, label, shape, words } from './describe.ts';

const LOGIN_WORDS = /\b(log ?in|sign ?in|authenticate)\b/i;
const LOGIN_PATH = /\/(log-?in|sign-?in|authenticate)$/i;

const guardsOf = (flow: Flow, graph: Lookup): GraphNode[] => {
  const { entry } = shape(flow, graph);
  return entry === undefined ? [] : graph.out(entry.id, 'guarded-by');
};

// UI: a form flow whose page, form, action or API call says log in. API: a POST to .../login, /signin or /authenticate.
export function isLogin(flow: Flow, graph: Lookup): boolean {
  const { entry, act, call } = shape(flow, graph);
  if (entry?.kind === 'route') return entry.attrs.method === 'POST' && LOGIN_PATH.test(entry.attrs.path);
  if (entry === undefined || act[0]?.kind !== 'form') return false;
  return [entry, ...act, ...(call === undefined ? [] : [call])].some((node) => LOGIN_WORDS.test(words(label(node))));
}

// PLAN.md Phase 4: Login is proposed as a shared subflow. Every flow whose entry is behind a guard starts with a step
// that points to the one unguarded login flow; with none or several, no step is added and the notes say why.
export function addLoginSubflows(flows: readonly Flow[], graph: Lookup): { flows: Flow[]; notes: string[] } {
  const guarded = flows.filter((flow) => guardsOf(flow, graph).length > 0);
  if (guarded.length === 0) return { flows: [...flows], notes: [] };
  const logins = flows.filter((flow) => isLogin(flow, graph) && guardsOf(flow, graph).length === 0);
  if (logins.length !== 1) {
    const found = logins.length === 0 ? 'no login flow was found' : `${logins.length} flows look like logging in (${logins.map((flow) => flow.id).join(', ')})`;
    return { flows: [...flows], notes: [`${guarded.length} flow(s) start behind a guard, but ${found}, so they get no Log-in step`] };
  }
  const [login] = logins;
  return {
    flows: flows.map((flow) => {
      const guards = guardsOf(flow, graph);
      if (guards.length === 0) return flow;
      const first = { kind: 'subflow' as const, claim: template('subflow', guards), subflow_ref: login.id, evidence: guards.map(evidenceOf), check: null, enabled: true };
      return { ...flow, steps: numbered([first, ...flow.steps.map(({ id: _, ...step }) => step)]) };
    }),
    notes: [],
  };
}
