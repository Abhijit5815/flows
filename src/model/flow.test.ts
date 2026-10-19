import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { FlowSchema, type Flow } from './flow.ts';
import { DEFAULT_CATEGORIES } from './category.ts';

const examplesDir = new URL('./examples/', import.meta.url);
const examples = new Map<string, unknown>(
  readdirSync(examplesDir).map((file) => [file, JSON.parse(readFileSync(new URL(file, examplesDir), 'utf8'))]),
);

test('every example flow is valid and uses a default category', () => {
  assert.ok(examples.size > 0, 'no example flows found');
  const categoryIds = new Set(DEFAULT_CATEGORIES.map((category) => category.id));
  for (const [file, data] of examples) {
    const result = FlowSchema.safeParse(data);
    assert.ok(result.success, `${file}:\n${result.success ? '' : z.prettifyError(result.error)}`);
    assert.ok(categoryIds.has(result.data.category), `${file}: unknown category "${result.data.category}"`);
  }
});

// Negative cases need values the types forbid; this is the only cast in these tests.
const forced = <T>(value: unknown): T => value as T;

const UI = 'login.ui.json'; // steps: ui, ui, api
const API = 'create-order.api.json'; // steps: subflow, api, api

const code = (node_id: string) => ({ type: 'code' as const, node_id, ref: 'app/page.tsx:1' });

// Each case breaks one rule in a valid example and expects that rule's error at that path.
const cases: { rule: string; file: string; breakIt: (flow: Flow) => void; path: string }[] = [
  { rule: 'a step needs evidence', file: UI, path: 'steps.0.evidence', breakIt: (f) => { f.steps[0].evidence = []; } },
  { rule: 'code evidence names a graph node', file: UI, path: 'steps.0.evidence.0.node_id', breakIt: (f) => { f.steps[0].evidence = forced([{ type: 'code', ref: 'app/page.tsx:1' }]); } },
  { rule: 'code evidence ref has a line number', file: UI, path: 'steps.0.evidence.0.ref', breakIt: (f) => { f.steps[0].evidence = [{ ...code('n1'), ref: 'app/page.tsx' }]; } },
  { rule: 'source flows cite code evidence only', file: UI, path: 'steps.0.evidence', breakIt: (f) => { f.steps[0].evidence.push({ type: 'network', ref: 'har:1' }); } },
  { rule: 'source flows cite code evidence only (in checks too)', file: UI, path: 'steps.0.check.evidence', breakIt: (f) => { f.steps[0].check!.evidence.push({ type: 'dom', ref: 'dom:1' }); } },
  { rule: 'api steps need a request', file: UI, path: 'steps.2.request', breakIt: (f) => { delete f.steps[2].request; } },
  { rule: 'only api steps have a request', file: UI, path: 'steps.0.request', breakIt: (f) => { f.steps[0].request = { method: 'GET', path: '/x' }; } },
  { rule: 'request paths start with /', file: UI, path: 'steps.2.request.path', breakIt: (f) => { f.steps[2].request = { method: 'POST', path: 'api/login' }; } },
  { rule: 'request methods are HTTP methods', file: UI, path: 'steps.2.request.method', breakIt: (f) => { f.steps[2].request = forced({ method: 'FETCH', path: '/x' }); } },
  { rule: 'subflow steps need subflow_ref', file: UI, path: 'steps.0.subflow_ref', breakIt: (f) => { f.steps[0].kind = 'subflow'; f.steps[0].check = null; } },
  { rule: 'only subflow steps have subflow_ref', file: UI, path: 'steps.0.subflow_ref', breakIt: (f) => { f.steps[0].subflow_ref = 'flow-other'; } },
  { rule: 'a check has the same kind as its step', file: UI, path: 'steps.0.check.kind', breakIt: (f) => { f.steps[0].check = { kind: 'api', status: 200, evidence: [code('n1')] }; } },
  { rule: 'subflow steps have no check', file: API, path: 'steps.0.check.kind', breakIt: (f) => { f.steps[0].check = { kind: 'api', status: 200, evidence: [code('n1')] }; } },
  { rule: 'a ui check needs a page or an element', file: UI, path: 'steps.0.check', breakIt: (f) => { f.steps[0].check = { kind: 'ui', evidence: [code('n1')] }; } },
  { rule: 'an api check needs a status or fields', file: API, path: 'steps.1.check', breakIt: (f) => { f.steps[1].check = { kind: 'api', evidence: [code('n1')] }; } },
  { rule: 'check status is an HTTP status', file: API, path: 'steps.1.check.status', breakIt: (f) => { f.steps[1].check = { kind: 'api', status: 700, evidence: [code('n1')] }; } },
  { rule: 'a check needs evidence', file: API, path: 'steps.1.check.evidence', breakIt: (f) => { f.steps[1].check = { kind: 'api', status: 201, evidence: [] }; } },
  { rule: 'api flows have no ui steps', file: API, path: 'steps.1.kind', breakIt: (f) => { f.steps[1].kind = 'ui'; delete f.steps[1].request; f.steps[1].check = null; } },
  { rule: 'a flow cannot use itself as a subflow', file: API, path: 'steps.0.subflow_ref', breakIt: (f) => { f.steps[0].subflow_ref = f.id; } },
  { rule: 'step ids are unique', file: UI, path: 'steps.1.id', breakIt: (f) => { f.steps[1].id = f.steps[0].id; } },
  { rule: 'a flow has at least one step', file: UI, path: 'steps', breakIt: (f) => { f.steps = []; } },
  { rule: 'confirmed means found in source and observed', file: UI, path: 'origin', breakIt: (f) => { f.status = 'confirmed'; } },
  { rule: 'verified means source only', file: UI, path: 'origin', breakIt: (f) => { f.origin = 'both'; } },
  { rule: 'observed-only means observed', file: UI, path: 'origin', breakIt: (f) => { f.status = 'observed-only'; } },
  { rule: 'status is one of the six statuses', file: UI, path: 'status', breakIt: (f) => { f.status = forced('done'); } },
  { rule: 'confidence is between 0 and 1', file: UI, path: 'confidence', breakIt: (f) => { f.confidence = 1.5; } },
  { rule: 'destructive is yes, no or unknown', file: UI, path: 'destructive', breakIt: (f) => { f.destructive = forced(true); } },
  { rule: 'priority is high, medium or low', file: UI, path: 'priority', breakIt: (f) => { f.priority = forced(1); } },
  { rule: 'version is a whole number from 1', file: UI, path: 'version', breakIt: (f) => { f.version = 0; } },
  { rule: 'schema_version is 0', file: UI, path: 'schema_version', breakIt: (f) => { f.schema_version = forced(1); } },
  { rule: 'a flow has a name', file: UI, path: 'name', breakIt: (f) => { f.name = ''; } },
];

for (const { rule, file, breakIt, path } of cases) {
  test(`rejects: ${rule}`, () => {
    const flow = FlowSchema.parse(structuredClone(examples.get(file)));
    breakIt(flow);
    const result = FlowSchema.safeParse(flow);
    assert.equal(result.success, false, 'the broken flow was accepted');
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    assert.ok(paths.includes(path), `expected an error at "${path}", got ${JSON.stringify(paths)}`);
  });
}
