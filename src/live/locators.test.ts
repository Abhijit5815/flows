import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Flow } from '../model/flow.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { startFakeServer } from '../shared/testing/fake-server.ts';
import { annotate, checksOf, playwrightSelector, verifyLocators } from './locators.ts';
import type { Run } from './run.ts';

test('a Flows selector becomes a Playwright one', () => {
  assert.equal(playwrightSelector('testid:add-1'), '[data-testid="add-1"]');
  assert.equal(playwrightSelector('attr:data-cy=save'), '[data-cy="save"]');
  assert.equal(playwrightSelector('id:login'), '[id="login"]');
  assert.equal(playwrightSelector('name:email'), '[name="email"]');
  assert.equal(playwrightSelector('role:button "Add to cart"'), 'role=button[name="Add to cart"]');
  assert.equal(playwrightSelector('xpath:/html/body/button[2]'), 'xpath=/html/body/button[2]');
});

// A sign-in flow as the code gives it: open /login, fill the form, call the API.
const flow = {
  id: 'ui-1',
  steps: [
    { id: 's1', kind: 'ui', check: { kind: 'ui', page: '/login' } },
    { id: 's2', kind: 'ui', check: { kind: 'ui', page: '/account' }, action: { kind: 'submit', fields: [{ name: 'email', selector: '[name="email"]' }, { name: 'nick', selector: '[name="nick"]' }], button: { text: 'Sign in', selector: 'role=button[name="Sign in"]' } } },
    { id: 's3', kind: 'api', request: { method: 'POST', path: '/api/login' }, check: null },
    { id: 's4', kind: 'subflow', subflow_ref: 'x', check: null },
  ],
} as unknown as Flow;

const run = {
  states: [{ path: '/login', forms: [{ fields: [{ name: 'email', selector: 'testid:email-input' }], submit: { text: 'Sign in', selector: 'id:go' } }], buttons: [] }],
  actions: [],
  requests: [{ kind: 'api', method: 'POST', path: '/api/login', blocked: true, status: null }],
} as unknown as Run;

test('selectors the app showed replace the code\'s, and a blocked write is not observed', () => {
  const [out] = annotate([flow], [run]);
  const action = out.steps[1].action;
  assert.deepEqual(action?.fields.map((f) => [f.selector, f.locator]), [['[data-testid="email-input"]', 'live'], ['[name="nick"]', 'source']]);
  assert.deepEqual([action?.button?.selector, action?.button?.locator], ['[id="go"]', 'live']);
  assert.deepEqual(out.steps.map((s) => s.observed), [true, false, false, undefined]);
});

test('without live runs nothing claims to be observed and every selector is from source', () => {
  const [out] = annotate([flow], []);
  assert.deepEqual(out.steps.map((s) => s.observed), [undefined, undefined, undefined, undefined]);
  assert.equal(out.steps[1].action?.fields[0].locator, 'source');
});

test('verify-locators counts elements on the real page and its result reaches the export', { skip: browserSkip }, async () => {
  const server = await startFakeServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/login' ? '<form><input name="email"><button>Sign in</button><button>Sign in</button></form>' : '<p>hi</p>');
  });
  try {
    const results = await verifyLocators([flow], new URL(server.url), { browser: undefined, storageState: undefined, safe: [] });
    const by = Object.fromEntries(results.map((r) => [r.selector, r.result]));
    assert.deepEqual(by, { '[name="email"]': 'verified', '[name="nick"]': 'missing', 'role=button[name="Sign in"]': 'ambiguous' });
    const [out] = annotate([flow], [], checksOf(results));
    assert.deepEqual(out.steps[1].action?.fields.map((f) => f.locator), ['verified', 'missing']);
    assert.equal(out.steps[1].action?.button?.locator, 'ambiguous');
  } finally {
    await server.close();
  }
});

test('a request body gets an example that passes its rules', async () => {
  const { exampleValue } = await import('../engine/examples.ts');
  const f = (name: string, type: string, rules: string[]) => ({ name, type, required: true, rules });
  assert.equal(exampleValue(f('email', 'string', ['email'])), 'test.user@example.com');
  assert.equal(String(exampleValue(f('password', 'string', ['min(12)']))).length >= 12, true);
  assert.equal(exampleValue(f('qty', 'number', ['int', 'positive'])), 1);
  assert.equal(exampleValue(f('qty', 'number', ['default(3)'])), 3);
});
