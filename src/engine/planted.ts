// PLAN.md Phase 4 exit: fabricated flows planted next to the genuine ones; the verifier must let none of them through.
// Each fake copies a genuine fixture flow and changes one thing. Used by verify.test.ts, with a stand-in grounding
// Decider and with the real entailment model.
import type { Flow } from '../model/flow.ts';
import { runClaim } from './describe.ts';

// context: genuine-looking flows a fake needs beside it (verified with it, never counted as fakes).
export type Kit = { copy(name: string): Flow; flow(name: string): Flow; context: unknown[] };
export type Fake = { name: string; make: (kit: Kit) => unknown[] };

type Step = Flow['steps'][number];
const last = (flow: Flow): Step => flow.steps[flow.steps.length - 1];
const at = (flow: Flow, kind: Step['kind']): Step => {
  const step = flow.steps.find((own) => own.kind === kind);
  if (step === undefined) throw new Error(`${flow.name} has no ${kind} step`);
  return step;
};
const one = (make: (kit: Kit) => unknown) => (kit: Kit) => [make(kit)];

// The express-basic fixture's API graph.
export const API_FAKES: Fake[] = [
  { name: 'a route that does not exist', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    Object.assign(last(flow), { claim: 'Call POST /api/v1/payments (handled by orders.list)', request: { method: 'POST', path: '/api/v1/payments' } });
    last(flow).evidence[0] = { type: 'code', node_id: 'api:route:POST /api/v1/payments', ref: 'src/routes/orders.routes.ts:12' };
    return flow;
  }) },
  { name: 'a real route cited at the wrong line', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    const item = last(flow).evidence[0];
    if (item.type === 'code') item.ref = item.ref.replace(/\d+$/, (line) => String(Number(line) + 1));
    return flow;
  }) },
  { name: 'a method the route does not answer', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/users/:id');
    last(flow).request = { method: 'DELETE', path: '/api/v1/users/:id' };
    return flow;
  }) },
  { name: 'a path the route does not have', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    last(flow).request = { method: 'GET', path: '/api/v1/orders/all' };
    return flow;
  }) },
  { name: 'a status the handler never sends', make: one((kit) => {
    const flow = kit.copy('POST /api/v1/orders');
    const check = last(flow).check;
    if (check?.kind === 'api') check.status = 200;
    return flow;
  }) },
  { name: 'a response field the handler never sends', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/users/me');
    const check = last(flow).check;
    if (check?.kind === 'api') check.fields = [...(check.fields ?? []), 'password'];
    return flow;
  }) },
  { name: "another handler's response as the check", make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    const other = last(kit.flow('POST /api/v1/orders')).check;
    if (other !== null) last(flow).check = structuredClone(other);
    return flow;
  }) },
  { name: 'a UI node in an API flow', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/products');
    last(flow).evidence.push({ type: 'code', node_id: 'web:page:/login', ref: 'app/(auth)/login/page.tsx:3' });
    return flow;
  }) },
  { name: 'a made-up claim on a real route', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    last(flow).claim = 'Delete every order in the database';
    return flow;
  }) },
  { name: 'a made-up name', make: one((kit) => ({ ...kit.copy('GET /api/v1/orders'), name: "Refund the customer's payment" })) },
  { name: 'a made-up description', make: one((kit) => ({ ...kit.copy('GET /api/v1/orders'), description: 'Charges the saved card and emails a receipt' })) },
  { name: 'observed evidence in a source flow', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/products');
    last(flow).evidence.push({ type: 'network', ref: 'GET /api/v1/products 200' });
    return flow;
  }) },
  { name: 'a step with no evidence', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/products');
    last(flow).evidence = [];
    return flow;
  }) },
  { name: 'a subflow that does not exist', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    at(flow, 'subflow').subflow_ref = 'api-00000000';
    return flow;
  }) },
  { name: 'a subflow that does not log in', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    at(flow, 'subflow').subflow_ref = kit.flow('DELETE /api/v1/orders/:orderId').id;
    return flow;
  }) },
  { name: 'a route the entry does not lead to', make: one((kit) => {
    const flow = kit.copy('GET /api/v1/orders');
    flow.steps.push({ ...structuredClone(last(kit.flow('POST /api/v1/users/register'))), id: 's9' });
    return flow;
  }) },
  { name: 'two flows that run each other (a cycle)', make: (kit) => {
    const [a, b] = [kit.copy('GET /api/v1/orders'), kit.copy('GET /api/v1/orders/:orderId')];
    const run = (target: Flow, id: string) => ({ id, kind: 'subflow' as const, claim: runClaim(target.name), subflow_ref: target.id, evidence: structuredClone(last(target).evidence), check: null, enabled: true });
    a.steps.push(run(b, 's8'));
    b.steps.push(run(a, 's8'));
    return [a, b];
  } },
  { name: 'subflows nested four deep', make: (kit) => {
    // c3 runs a guarded flow (depth 2), c2 runs c3 (3, the cap), and the fake runs c2: 4.
    const run = (target: Flow) => ({ id: 's8', kind: 'subflow' as const, claim: runClaim(target.name), subflow_ref: target.id, evidence: structuredClone(last(target).evidence), check: null, enabled: true });
    const [fake, c2, c3] = [kit.copy('GET /api/v1/users/me'), kit.copy('GET /api/v1/users/me'), kit.copy('GET /api/v1/users/me')];
    c3.steps.push(run(kit.flow('GET /api/v1/orders')));
    c2.steps.push(run(c3));
    fake.steps.push(run(c2));
    kit.context.push(c2, c3);
    return [fake];
  } },
];

// The next-basic fixture's UI graph.
export const UI_FAKES: Fake[] = [
  { name: 'a page that does not exist', make: one((kit) => {
    const flow = kit.copy('User can view the products page');
    Object.assign(flow.steps[0], { claim: 'Open /checkout', evidence: [{ type: 'code', node_id: 'web:page:/checkout', ref: 'app/(shop)/checkout/page.tsx:3' }], check: null });
    return flow;
  }) },
  { name: 'a form from another page', make: one((kit) => {
    const flow = kit.copy('User can sign in');
    const profile = kit.flow('User can save profile').steps.find((step) => step.claim.startsWith('Fill in'));
    if (profile !== undefined) flow.steps[1] = { ...structuredClone(profile), id: 's2' };
    return flow;
  }) },
  { name: 'an API call the action does not make', make: one((kit) => {
    const flow = kit.copy('User can sign in');
    last(flow).request = { method: 'POST', path: '/api/auth/register' };
    return flow;
  }) },
  { name: 'an element the page does not show', make: one((kit) => {
    const flow = kit.copy('User can view the login page');
    const form = kit.flow('User can save profile').steps.find((step) => step.claim.startsWith('Fill in'))?.evidence[0];
    if (form !== undefined) flow.steps[0].check = { kind: 'ui', element: 'ProfileForm#form', evidence: [form] };
    return flow;
  }) },
  { name: 'a page the step does not open', make: one((kit) => {
    const flow = kit.copy('User can view the login page');
    const account = kit.flow('User can view the account page').steps.find((step) => step.kind === 'ui')?.evidence[0];
    if (account !== undefined) flow.steps[0].check = { kind: 'ui', page: '/account', evidence: [account] };
    return flow;
  }) },
  { name: 'a UI step that cites only an API call', make: one((kit) => {
    const flow = kit.copy('User can sign in');
    flow.steps[1] = { ...flow.steps[1], claim: 'Calls POST /api/auth/login', evidence: structuredClone(last(flow).evidence) };
    return flow;
  }) },
  { name: 'a made-up claim on a real form', make: one((kit) => {
    const flow = kit.copy('User can save profile');
    const fill = flow.steps.find((step) => step.claim.startsWith('Fill in'));
    if (fill !== undefined) fill.claim = 'Pay for the order with a saved card';
    return flow;
  }) },
  { name: 'an API check in a UI flow', make: one((kit) => {
    const flow = kit.copy('User can sign in');
    last(flow).check = { kind: 'api', status: 200, evidence: structuredClone(last(flow).evidence) };
    return flow;
  }) },
];
