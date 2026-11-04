import { z } from 'zod';
import type { Flow } from '../model/flow.ts';
import type { OptionalLlm } from './llm.ts';
import { fingerprint } from './since.ts';
import type { FlowSet } from './store.ts';
import { stepDetails, stepLine } from './views.ts';

// An AI's review of one flow as a QA engineer would give it: is it a sound functional check, and does it run end to
// end. It is advice shown beside the flow; it never switches a flow on or off. `print` is the flow's fingerprint when
// it was reviewed, so a flow that changed since is no longer shown as reviewed.
export const QaSchema = z.object({
  verdict: z.enum(['ready', 'needs-work', 'not-testable']),
  functional: z.string().min(5).max(400),
  end_to_end: z.string().min(5).max(400),
  gaps: z.array(z.string().min(3).max(240)).max(6),
});
export const QaEntrySchema = QaSchema.extend({ print: z.string(), at: z.string() });
export type QaEntry = z.infer<typeof QaEntrySchema>;

const SYSTEM =
  'You are a senior QA engineer reviewing one user flow of a web application, taken from its source code, before it is ' +
  'turned into an automated test. Judge two things only from the steps you are given. functional: does each step ' +
  'check something observable (a status, fields, a page, a message), and are the expected results specific enough to ' +
  'assert? end_to_end: does it start where a real user or client starts, include what it needs first (sign-in, data, ' +
  'an earlier step), follow the main success path to a result, and name the failure cases worth testing? Reply with ' +
  'JSON only: {"verdict": "ready" | "needs-work" | "not-testable", "functional": "...", "end_to_end": "...", ' +
  '"gaps": ["..."]}. ready: a tester could write the test from it as it stands. needs-work: usable, but the gaps ' +
  'listed would have to be filled first. not-testable: too little to test, or it depends on something the steps do ' +
  'not say. Each of functional and end_to_end is one or two sentences. gaps are short, concrete and at most six. ' +
  'Say only what the steps support; never invent pages, fields or data.';

// The flow as the AI reads it: its steps in the shape of `flows show flows`, and the steps of each subflow it runs.
function describe(flow: Flow, byId: ReadonlyMap<string, Flow>): string {
  const lines = (own: Flow) => own.steps.flatMap((step) => [stepLine(step), ...stepDetails(step).map((line) => `  ${line}`)]);
  const subs = [...new Set(flow.steps.flatMap((step) => (step.subflow_ref === undefined ? [] : [step.subflow_ref])))].flatMap((id) => {
    const sub = byId.get(id);
    return sub === undefined ? [] : [`Subflow ${id} (${sub.name}):`, ...lines(sub).map((line) => `  ${line}`)];
  });
  return [`Flow: ${flow.name} (${flow.kind === 'ui' ? 'user interface' : 'API'})`, ...(flow.description === undefined ? [] : [flow.description]), 'Steps:', ...lines(flow), ...subs].join('\n');
}

// Reviews the given flows of one set, keeping each answer; a flow the AI could not be asked about is left as it was.
// Returns how many were reviewed.
export async function qaFlows(set: FlowSet, ids: ReadonlySet<string>, llm: OptionalLlm, at: string): Promise<number> {
  const byId = new Map(set.flows.map((flow) => [flow.id, flow]));
  let done = 0;
  for (const flow of set.flows) {
    if (!ids.has(flow.id)) continue;
    const reply = await llm.ask({ purpose: 'flow-qa', system: SYSTEM, prompt: describe(flow, byId), schema: QaSchema });
    if (reply === undefined) continue;
    set.qa[flow.id] = { ...reply, print: fingerprint(flow), at };
    done++;
  }
  return done;
}

// Not a QA run: keep each review whose flow is still there and unchanged.
export function carryQa(set: FlowSet, previous: FlowSet | undefined): FlowSet['qa'] {
  return Object.fromEntries(set.flows.flatMap((flow) => {
    const kept = previous?.qa[flow.id];
    return kept !== undefined && kept.print === fingerprint(flow) ? [[flow.id, kept] as const] : [];
  }));
}
