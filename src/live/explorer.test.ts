import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLiveFixture, type LiveFixture } from '../../fixtures/live/server.ts';
import type { ExplorerConfig } from '../config/project.ts';
import { UNKNOWN, type Decider } from '../decider/decider.ts';
import { OptionalLlm } from '../engine/llm.ts';
import { LiveError } from '../shared/errors.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { explore, type ExploreInput } from './explorer.ts';
import type { Run } from './run.ts';

const options = { email: 'shopper@example.com', password: randomBytes(9).toString('hex'), secret: `tok_${randomBytes(16).toString('hex')}` };
const tmp = mkdtempSync(join(tmpdir(), 'flows-explore-'));
let site: LiveFixture;

before(async () => {
  if (browserSkip === false) site = await startLiveFixture(options);
});
after(async () => {
  await site?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const answer = (label: string, prob: number) => ({ label, prob, all_probs: { [label]: prob }, version: 'stub' });

// A stand-in Decider: deleting and cancelling are destructive, subscribing is safe but not sure enough, saving a
// profile is unknown, and everything else is safe; tracking and health calls are noise.
const decider: Decider = {
  async decide(task, text) {
    if (task === 'event-noise') return answer(/track|health/.test(text) ? 'noise' : 'relevant', 0.9);
    if (/delete|cancel/i.test(text)) return answer('destructive', 0.9);
    if (/subscribe/i.test(text)) return answer('safe', 0.6);
    return answer('safe', 0.95);
  },
};
const config: ExplorerConfig = { max_pages: 30, max_depth: 3, min_safe_prob: 0.8, logins: {} };
const deps = { decider, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => undefined), config, runDir: (id: string) => join(tmp, id), log: () => undefined };
const input = (overrides: Partial<ExploreInput> = {}): ExploreInput => ({
  url: site.url,
  session: null,
  storageState: undefined,
  credentials: undefined,
  saveSessionTo: undefined,
  pages: ['/', '/login', '/products', '/products/[id]', '/cart', '/docs/[...slug]', '/account', '/account/orders'],
  headless: true,
  ...overrides,
});

const paths = (run: Run) => run.states.map((state) => state.path);
const skipped = (run: Run) => run.actions.filter((action) => !action.taken).map((action) => `${action.element.text}: ${action.decision.reason}`);

let signedOut: Run;

test('signed out: it follows the links and controls it may, and nothing it does reaches the app as a write', { skip: browserSkip }, async () => {
  const before = { writes: site.writes.length, sockets: site.sockets, logouts: site.logouts };
  signedOut = await explore(input(), deps);
  assert.deepEqual(site.writes.slice(before.writes), [], 'no write reached the app');
  assert.equal(site.sockets, before.sockets, 'no WebSocket reached the app');
  assert.equal(site.logouts, before.logouts, 'the GET sign-out link was never followed');

  assert.deepEqual(new Set(paths(signedOut)), new Set(['/', '/products', '/products/1', '/about', '/login']));
  assert.equal(signedOut.states.filter((state) => state.path === '/').length, 2, 'the home page, and the home page with the login dialog open');
  assert.equal(signedOut.states.find((state) => state.path === '/login')?.requested, '/cart', 'a guarded page shows where the guard sent the browser');
  const reasons = skipped(signedOut);
  for (const expected of ['Sign out: it would end the session', 'Help: it leads to another site', 'Email us: a mailto: link, not a page', 'Sign in: it asks for a password']) assert.ok(reasons.includes(expected), `${expected} in ${reasons.join(' | ')}`);
  assert.ok(reasons.some((reason) => reason.startsWith('Subscribe: rated safe, but only p=0.60')), 'a less sure "safe" is not taken');

  const blocked = signedOut.requests.filter((request) => request.blocked).map((request) => `${request.method} ${request.path}`);
  assert.ok(blocked.includes('POST /api/cart/items'), 'add to cart was clicked, and its write blocked');
  assert.ok(signedOut.requests.filter((request) => request.path === '/api/notifications').every((request) => request.noise?.label === 'noise'), 'polling is noise');
  assert.equal(signedOut.requests.find((request) => request.path === '/api/track')?.noise?.label, 'noise');
  assert.equal(signedOut.requests.find((request) => request.path === '/api/products')?.noise?.label, 'relevant');
  assert.ok(signedOut.states.every((state) => state.shot !== null && existsSync(join(tmp, signedOut.id, state.shot))), 'every state has its screenshot');
});

test('with env credentials it logs in through the login dialog, saves the session, and still writes nothing else', { skip: browserSkip }, async () => {
  const before = site.writes.length;
  const sessionFile = join(tmp, 'sessions', 'tester.json');
  const run = await explore(input({ session: 'tester', credentials: { user: options.email, password: options.password, path: undefined }, saveSessionTo: sessionFile }), deps);
  assert.deepEqual(site.writes.slice(before), ['POST /api/auth/login'], 'only the login submit reached the app');
  assert.ok(existsSync(sessionFile), 'the session was saved');
  assert.ok(paths(run).includes('/account') && paths(run).includes('/account/orders') && paths(run).includes('/cart'));
  const reasons = skipped(run);
  assert.ok(reasons.some((reason) => reason.startsWith('Delete account: rated destructive')), reasons.join(' | '));
  assert.ok(reasons.some((reason) => reason.startsWith('Cancel order: rated destructive')), reasons.join(' | '));
  assert.ok(reasons.includes('Log out: it would end the session'));
  assert.ok(run.requests.some((request) => request.blocked && request.method === 'PATCH' && request.path === '/api/me'), 'the profile form was submitted, and its write blocked');
  assert.ok(!JSON.stringify(run).includes(options.password), 'the password is in no run file');

  const again = await explore(input({ session: 'tester', storageState: sessionFile }), deps);
  assert.ok(paths(again).includes('/account'), 'the saved session signs the next run in');
});

test('a login that fails says so, and a run never invents credentials', { skip: browserSkip }, async () => {
  await assert.rejects(explore(input({ session: 'tester', credentials: { user: options.email, password: 'wrong', path: '/login' } }), deps), (error) => error instanceof LiveError && /didn't work/.test(error.message));
});

test('the URL must be an http or https URL', async () => {
  await assert.rejects(explore({ url: 'file:///etc/passwd', session: null, storageState: undefined, credentials: undefined, saveSessionTo: undefined, pages: [], headless: true }, deps), (error) => error instanceof LiveError);
});
