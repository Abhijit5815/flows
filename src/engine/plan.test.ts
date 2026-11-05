import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Flow } from '../model/flow.ts';
import { planOf } from './plan.ts';

const flows = [
  { id: 'a', name: ' User can sign in', category: 'auth', kind: 'ui', steps: [
    { id: 's1', kind: 'ui', claim: 'Open /login', check: { kind: 'ui', page: '/login' } },
    { id: 's2', kind: 'ui', claim: 'Fill in', check: { kind: 'ui', page: '/account' }, errors: [{ kind: 'ui', message: 'Wrong email or password.' }], action: { kind: 'submit', fields: [{ name: 'email', selector: '[name="email"]', locator: 'verified' }], button: { text: 'Sign in', selector: 'role=button[name="Sign in"]', locator: 'source' } } },
  ] },
  { id: 'b', name: 'POST /api/orders', category: 'auth', kind: 'api', steps: [
    { id: 's1', kind: 'subflow', claim: 'Log in first', subflow_ref: 'a' },
    { id: 's2', kind: 'api', claim: 'Call', request: { method: 'POST', path: '/api/orders', body: { example: { qty: 1 }, example_missing: ['currency'] } }, check: { kind: 'api', status: 201, fields: ['data'] }, observed: false, errors: [{ kind: 'api', status: 400, by: 'validate', when: 'the body breaks schema' }] },
  ] },
] as unknown as Flow[];

test('the flows become a Playwright planner plan', () => {
  const plan = planOf(flows, { name: 'Shop', baseUrl: 'http://localhost:3000', categories: new Map([['auth', 'Sign-in & account']]) });
  assert.match(plan, /^# Shop Test Plan/);
  assert.match(plan, /### 1\. Sign-in & account\n\n\*\*Seed:\*\* `tests\/seed\.spec\.ts`/);
  assert.match(plan, /#### 1\.1 User can sign in\n\n\*\*File:\*\* `tests\/sign-in-account\/user-can-sign-in\.spec\.ts`/);
  assert.match(plan, /1\. Open \/login/);
  assert.match(plan, /Fill email using \[name="email"\] \(verified\)/);
  assert.match(plan, /Click "Sign in" using role=button\[name="Sign in"\] \(from code, unchecked\)/);
  assert.match(plan, /error case: invalid input shows "Wrong email or password\."/);
  assert.match(plan, /Precondition: Log in first; the scenario "User can sign in" shows how/);
  assert.match(plan, /Send POST \/api\/orders with the JSON body \{"qty":1\} \(not seen on the live app\)/);
  assert.match(plan, /expect: status 201; body has data/);
  assert.match(plan, /also required, and Flows could not read the allowed values for: currency/);
  assert.match(plan, /error case: the body breaks schema gives 400/);
});
