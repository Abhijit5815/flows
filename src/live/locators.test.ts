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

test('a control behind a click is found by pressing the button that shows it, and the export says which', { skip: browserSkip }, async () => {
  const server = await startFakeServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/login' ? '<button onclick="document.getElementById(\'f\').hidden=false">Show form</button><button>Delete everything</button><form id="f" hidden><input name="email"></form>' : '<p>hi</p>');
  });
  try {
    const results = await verifyLocators([flow], new URL(server.url), { browser: undefined, storageState: undefined, safe: [] });
    const email = results.find((r) => r.selector === '[name="email"]');
    assert.deepEqual([email?.result, email?.after], ['verified', ['role=button[name="Show form"]']]);
    const [out] = annotate([flow], [], checksOf(results));
    assert.deepEqual(out.steps[1].action?.fields[0].after, ['role=button[name="Show form"]']);
  } finally {
    await server.close();
  }
});

test('the export says which login saw a step, shows a real answer, and how to get an id the path needs', () => {
  const api = (method: string, path: string, extra = {}) => ({ id: 's', kind: 'api', request: { method, path, ...extra }, check: null });
  const f = {
    id: 'a',
    steps: [
      api('GET', '/api/ideas'),
      api('POST', '/api/ideas', { body: { schema: 'x', fields: [{ name: 'title', type: 'string', required: true, rules: [] }], evidence: [] } }),
      api('GET', '/api/ideas/:ideaId/members'),
    ],
  } as unknown as Flow;
  const seen = { session: 'funder', states: [], actions: [], requests: [{ kind: 'api', method: 'GET', path: '/api/ideas/7/members', blocked: false, status: 200, response: { type: 'json', fields: ['a'], body: { data: [1] } } }] } as unknown as Run;
  const [out] = annotate([f], [seen]);
  assert.deepEqual(out.steps[2].setup, [{ param: 'ideaId', create: 'POST /api/ideas', body: { title: 'test' }, list: 'GET /api/ideas' }]);
  assert.deepEqual(out.steps[2].observed_as, ['funder']);
  assert.deepEqual(out.steps[2].response_example, { data: [1] });
  assert.equal(out.steps[0].observed, false);
});

test('four look-alike clicks on one page fold into one flow, fewer stay as they are', async () => {
  const { foldClicks } = await import('./observed.ts');
  const click = (label: string) => ({ flow: { id: label, name: label, steps: [{ claim: 'Open /d' }, { claim: `Click "${label}"` }] }, page: { pattern: '/d' }, act: { kind: 'click', text: label }, calls: [], text: label, noise: false, run: 'r' }) as never;
  const four = ['a', 'b', 'c', 'd'].map(click);
  const out = foldClicks(four);
  assert.equal(out.length, 1);
  assert.match(out[0].flow.steps[1].claim, /^Click one of 4 look-alike controls: "a", "b", "c", "d"$/);
  assert.equal(foldClicks(four.slice(0, 3)).length, 3);
});

test('examples use the first allowed value, leave out what could not be read, and a control seen on another page is not borrowed', async () => {
  const { exampleValue, withExamples } = await import('../engine/examples.ts');
  const f = (name: string, type: string, rules: string[]) => ({ name, type, required: true, rules });
  assert.equal(exampleValue(f('category', 'enum', ["enum(['tech', 'food'])"])), 'tech');
  assert.equal(exampleValue(f('category', 'enum', ['enum(…)'])), undefined);
  assert.deepEqual(exampleValue(f('criteria', 'record', ['record(z.unknown())'])), {});
  assert.equal(String(exampleValue(f('description', 'string', ['trim', 'min(LIMITS.MIN)']))).length >= 40, true);
  const api = { id: 'a', steps: [{ id: 's', kind: 'api', check: null, request: { method: 'POST', path: '/x', body: { schema: 's', evidence: [], fields: [f('title', 'string', []), f('category', 'enum', ['enum(…)'])] } } }] } as unknown as Flow;
  assert.deepEqual(withExamples([api])[0].steps[0].request?.body?.example_missing, ['category']);
  const elsewhere = { states: [{ path: '/signup', forms: [{ fields: [{ name: 'email', selector: 'testid:signup-email' }], submit: null }], buttons: [] }], actions: [], requests: [] } as unknown as Run;
  const [out] = annotate([flow], [elsewhere]);
  assert.equal(out.steps[1].action?.fields[0].selector, '[name="email"]', 'the login keeps its own selector');
  assert.equal(out.steps[1].action?.fields[0].locator, 'source');
});

test('example text carries the project marker, but a password and an email do not', async () => {
  const { exampleValue } = await import('../engine/examples.ts');
  const f = (name: string, type: string, rules: string[]) => ({ name, type, required: true, rules });
  assert.equal(exampleValue(f('title', 'string', ['min(3)']), 'Test Flows '), 'Test Flows test');
  assert.equal(String(exampleValue(f('password', 'string', ['min(8)']), 'Test Flows ')).startsWith('Passw0rd'), true);
  assert.equal(exampleValue(f('email', 'string', ['email']), 'Test Flows '), 'test.user@example.com');
});
