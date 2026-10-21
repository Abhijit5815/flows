import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Browser } from 'playwright-core';
import { startLiveFixture, type LiveFixture } from '../../fixtures/live/server.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { launchBrowser, newContext } from './browser.ts';
import { guardReadOnly } from './readonly.ts';

// Test values only, made fresh for each run.
const options = { email: 'shopper@example.com', password: randomBytes(9).toString('hex'), secret: `tok_${randomBytes(16).toString('hex')}` };
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
});

// Waits until the pages' own scripts (beacon, polling, socket) have had time to run.
const settle = (ms = 600) => new Promise((done) => setTimeout(done, ms));

test('the read-only guard stops every write and WebSocket before it reaches the app, and records each one', { skip: browserSkip }, async () => {
  const context = await newContext(browser);
  const guard = await guardReadOnly(context);
  await context.addCookies([{ name: 'session', value: site.session(), url: site.url }]);
  const page = await context.newPage();

  await page.goto(`${site.url}/products`);
  await page.getByTestId('add-1').click();
  await page.goto(`${site.url}/account`);
  await page.locator('#profile input[name=name]').fill('A. Shopper');
  await page.locator('#profile button').click();
  await page.locator('#delete-account').click();
  await page.goto(`${site.url}/about`);
  await page.locator('input[name=newsletter]').fill('news@example.com');
  await page.getByRole('button', { name: 'Subscribe' }).click();
  await settle();

  assert.deepEqual(site.writes, [], 'no write reached the app');
  assert.equal(site.sockets, 0, 'no WebSocket reached the app');
  const blocked = new Set(guard.blocked.map((write) => `${write.method} ${new URL(write.url).pathname}`));
  for (const expected of ['POST /api/cart/items', 'PATCH /api/me', 'DELETE /api/me', 'POST /subscribe', 'POST /api/track']) assert.ok(blocked.has(expected), `${expected} was recorded as blocked`);
  assert.ok(guard.sockets.some((url) => url.endsWith('/ws')), 'the WebSocket was recorded');
  const profile = guard.blocked.find((write) => write.method === 'PATCH');
  assert.deepEqual(profile?.shape, { name: 'string', email: 'string', street: 'string', city: 'string' }, 'a blocked body keeps its shape, not its values');
  await context.close();
});

test('allowLogin lets the login submit through, and no other write, even at the same moment', { skip: browserSkip }, async () => {
  const before = site.writes.length;
  const context = await newContext(browser);
  const guard = await guardReadOnly(context);
  const page = await context.newPage();
  await page.goto(`${site.url}/login`);
  await page.locator('#login input[name=email]').fill(options.email);
  await page.locator('#login input[name=password]').fill(options.password);
  await guard.allowLogin(options.password, async () => {
    await page.locator('#login button[type=submit]').click();
    await page.waitForURL(`${site.url}/account`);
  });
  await settle();
  assert.deepEqual(site.writes.slice(before), ['POST /api/auth/login'], 'only the login submit got through');
  assert.ok(guard.blocked.some((write) => write.url.endsWith('/api/track')), 'the beacons were blocked, during the login too');
  await context.close();
});
