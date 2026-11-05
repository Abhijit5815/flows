import type { Flow } from '../model/flow.ts';

type Step = Flow['steps'][number];
type Named = { id: string; name: string };

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'flow';

// A flow's steps as the numbered steps and "expect" lines of Playwright's test planner (the format its generator
// reads: "### 1. Group", "**Seed:**", "#### 1.1 Scenario", "**Steps:**"). Every claim comes from the export, so it
// carries what Flows knows (selectors and how far to trust them, example values, errors) and says what it does not.
function stepLines(step: Step, byId: ReadonlyMap<string, Flow>): string[] {
  const note = step.observed === false ? ' (not seen on the live app)' : '';
  if (step.kind === 'subflow') {
    const target = step.subflow_ref === undefined ? undefined : byId.get(step.subflow_ref);
    return [`Precondition: ${step.claim}${target === undefined ? '' : `; the scenario "${target.name}" shows how`}`];
  }
  const out: string[] = [];
  if (step.kind === 'api' && step.request !== undefined) {
    const body = step.request.body?.example;
    out.push(`Send ${step.request.method} ${step.request.path}${body === undefined ? '' : ` with the JSON body ${JSON.stringify(body)}`}${note}`);
    const missing = step.request.body?.example_missing;
    if (missing !== undefined) out.push(`  - also required, and Flows could not read the allowed values for: ${missing.join(', ')}`);
    for (const need of step.setup ?? []) out.push(`  - setup: for ${need.param}, ${need.create === undefined ? '' : `create one with ${need.create}${need.body === undefined ? '' : ` ${JSON.stringify(need.body)}`}`}${need.create !== undefined && need.list !== undefined ? ', or ' : ''}${need.list === undefined ? '' : `pick one from ${need.list}`}`);
    if (step.check?.kind === 'api') out.push(`  - expect: ${[step.check.status === undefined ? '' : `status ${step.check.status}`, step.check.fields === undefined ? '' : `body has ${step.check.fields.join(', ')}`].filter(Boolean).join('; ')}`);
    if (step.response_example !== undefined) out.push(`  - example answer: ${JSON.stringify(step.response_example).slice(0, 300)}`);
    for (const error of step.errors ?? []) if (error.kind === 'api') out.push(`  - error case: ${error.when ?? error.by} gives ${error.status}${error.message === undefined ? '' : ` "${error.message}"`}`);
    return out;
  }
  const action = step.action;
  if (action === undefined) {
    out.push(`${step.claim}${note}`);
    if (step.check?.kind === 'ui') out.push(`  - expect: ${[step.check.page === undefined ? '' : `the URL is ${step.check.page}`, step.check.text === undefined ? '' : `the page shows ${step.check.text.map((t) => `"${t}"`).join(', ')}`].filter(Boolean).join('; ')}`);
    return out;
  }
  const trust = (c: { selector: string; locator?: string; after?: string[] }) => `${c.selector}${c.locator === undefined || c.locator === 'source' ? ' (from code, unchecked)' : ` (${c.locator})`}`;
  for (const first of new Set([...action.fields, ...(action.button === undefined ? [] : [action.button])].flatMap((c) => c.after ?? []))) out.push(`Click ${first} first (it reveals the next controls)`);
  for (const field of action.fields) out.push(`Fill ${field.name} using ${trust(field)}`);
  if (action.button !== undefined) out.push(`Click "${action.button.text}" using ${trust(action.button)}${note}`);
  if (step.check?.kind === 'ui' && step.check.page !== undefined) out.push(`  - expect: the URL becomes ${step.check.page}`);
  for (const error of step.errors ?? []) if (error.kind === 'ui') out.push(`  - error case: ${error.when ?? 'invalid input'} shows "${error.message}"`);
  return out;
}

export function planOf(flows: readonly Flow[], opts: { name: string; baseUrl: string | null; categories: ReadonlyMap<string, string> }): string {
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const groups = new Map<string, Flow[]>();
  for (const flow of flows) groups.set(flow.category, [...(groups.get(flow.category) ?? []), flow]);
  const lines = [`# ${opts.name} Test Plan`, '', '## Application Overview', '', `${flows.length} flows found by Flows from the app's source${opts.baseUrl === null ? '' : ` and its running copy at ${opts.baseUrl}`}. Selectors say how far to trust them; "not seen on the live app" steps come from source only.`, '', '## Test Scenarios', ''];
  [...groups.entries()].forEach(([category, list], g) => {
    const title = opts.categories.get(category) ?? category;
    lines.push(`### ${g + 1}. ${title}`, '', '**Seed:** `tests/seed.spec.ts`', '');
    list.forEach((flow: Named & Flow, i) => {
      lines.push(`#### ${g + 1}.${i + 1} ${flow.name}`, '', `**File:** \`tests/${slug(title)}/${slug(flow.name)}.spec.ts\``, '', '**Steps:**');
      flow.steps.flatMap((step) => stepLines(step, byId)).reduce((n, line) => {
        const sub = line.startsWith('  ');
        lines.push(sub ? `   ${line.trim().replace(/^- /, '- ')}` : `  ${n + 1}. ${line}`);
        return sub ? n : n + 1;
      }, 0);
      lines.push('');
    });
  });
  return `${lines.join('\n')}\n`;
}
