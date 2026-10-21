import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { JWT_CANARY, startLiveFixture, type LiveFixture } from '../../fixtures/live/server.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { launchBrowser, newContext } from './browser.ts';
import { captureState, Recorder } from './capture.ts';
import { siteOf } from './noise.ts';
import { guardReadOnly } from './readonly.ts';

const options = { email: 'shopper@example.com', password: randomBytes(9).toString('hex'), secret: `tok_${randomBytes(16).toString('hex')}` };
const dir = mkdtempSync(join(tmpdir(), 'flows-capture-'));
let site: LiveFixture;
let browser: Browser;

before(async () => {
  if (browserSkip !== false) return;
  site = await startLiveFixture(options);
  browser = (await launchBrowser(undefined, true)).browser;
});
after(async () => {
  await browser?.close();
  await site?.close();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 700) => new Promise((done) => setTimeout(done, ms));

async function open(path: string, signedIn: boolean) {
  const context = await newContext(browser);
  const guard = await guardReadOnly(context);
  if (signedIn) await context.addCookies([{ name: 'session', value: site.session(), url: site.url }]);
  const recorder = new Recorder(context, siteOf(new URL(site.url).hostname), guard);
  const page = await context.newPage();
  recorder.where.state = 0;
  await page.goto(`${site.url}${path}`);
  await settle();
  const state = await captureState(page, dir, 0, null, null);
  await recorder.settled();
  return { context, recorder, state };
}

test('a page state lists its links, buttons and forms with the most stable selector each has', { skip: browserSkip }, async () => {
  const { context, state, recorder } = await open('/products', false);
  assert.equal(state.path, '/products');
  assert.deepEqual(
    state.links.filter((link) => link.href.startsWith(site.url)).map((link) => link.text),
    ['Home', 'Products', 'Cart', 'Account', 'About', 'Sign out', 'Lamp', 'Chair'],
  );
  assert.deepEqual(
    state.buttons.map((button) => [button.text, button.selector, button.stable]),
    [
      ['Log in', 'id:open-login', true],
      ['Search', 'role:button "Search"', true],
      ['Add to cart', 'testid:add-1', true],
      ['Add to cart', 'testid:add-2', true],
    ],
  );
  assert.deepEqual(
    state.forms.map((form) => [form.method, form.fields.map((field) => field.name), form.submit?.text]),
    [['GET', ['q'], 'Search']],
    'the search form; the login form in the closed dialog is not visible',
  );
  assert.equal(state.password, false);
  assert.ok(readdirSync(dir).includes('s0.jpg'), 'a screenshot was saved');

  const calls = recorder.requests.filter((request) => request.kind === 'api').map((request) => `${request.method} ${request.path} ${request.blocked ? 'blocked' : request.status}`);
  for (const expected of ['GET /api/products 200', 'GET /api/v1/products 200', 'POST /api/track blocked']) assert.ok(calls.includes(expected), `${expected} in ${calls.join(', ')}`);
  assert.deepEqual(recorder.requests.find((request) => request.path === '/api/products')?.response?.fields, ['id', 'name', 'price']);
  assert.ok(recorder.requests.some((request) => request.kind === 'external' && request.url.includes('pixel.invalid')), 'the other site is external');
  assert.ok(recorder.requests.some((request) => request.kind === 'page' && request.path === '/products'));
  await context.close();
});

test('a guard that redirects shows as a state on the page the app sent the browser to', { skip: browserSkip }, async () => {
  const { context, state } = await open('/cart', false);
  assert.equal(state.path, '/login');
  assert.equal(state.password, true);
  assert.deepEqual(state.forms[0]?.fields.map((field) => [field.name, field.type, field.required]), [
    ['email', 'email', true],
    ['password', 'password', true],
  ]);
  await context.close();
});

test('no canary reaches what is kept: emails, tokens, JWTs and passwords are redacted in text and bodies', { skip: browserSkip }, async () => {
  const { context, state, recorder } = await open('/account', true);
  const me = recorder.requests.find((request) => request.path === '/api/v1/users/me');
  assert.deepEqual(me?.response?.body, { success: true, data: { id: 'u1', email: '[email]', apiToken: '[redacted]', note: '[jwt]' }, error: null, timestamp: (me?.response?.body as { timestamp: number }).timestamp });
  assert.match(state.text, /Signed in as \[email\]/);
  const kept = JSON.stringify({ state, requests: recorder.requests });
  for (const canary of [options.email, options.secret, options.password, JWT_CANARY]) assert.ok(!kept.includes(canary), `${canary.slice(0, 8)}… is not kept`);
  await context.close();
});
