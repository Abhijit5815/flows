import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markPolling } from './capture.ts';
import { kindOf, siteOf } from './noise.ts';
import type { RequestRecord } from './run.ts';

test('a site is the registrable domain, and every loopback host is one site', () => {
  assert.equal(siteOf('app.example.com'), siteOf('api.example.com'));
  assert.notEqual(siteOf('example.com'), siteOf('analytics.example.net'));
  assert.equal(siteOf('localhost'), siteOf('127.0.0.1'));
  assert.equal(siteOf('web.localhost'), siteOf('[::1]'));
  assert.notEqual(siteOf('localhost'), siteOf('pixel.invalid'));
});

test('rules sort requests: pages, assets, framework internals, real-time, other sites, and the app’s own calls', () => {
  const site = siteOf('localhost');
  const kind = (url: string, resource: string, headers: Record<string, string> = {}) => kindOf(new URL(url), resource, headers, site);
  assert.equal(kind('http://localhost:3000/settings', 'document'), 'page');
  assert.equal(kind('http://localhost:3000/logo.png', 'image'), 'asset');
  assert.equal(kind('http://localhost:3000/_next/static/chunks/main.js', 'script'), 'asset');
  assert.equal(kind('http://localhost:3000/settings?_rsc=1x2', 'fetch'), 'framework');
  assert.equal(kind('http://localhost:3000/settings', 'fetch', { rsc: '1' }), 'framework');
  assert.equal(kind('http://localhost:3001/socket.io/?EIO=4&transport=polling', 'xhr'), 'realtime');
  assert.equal(kind('https://www.google-analytics.com/g/collect', 'fetch'), 'external');
  assert.equal(kind('http://127.0.0.1:3001/v1/games', 'fetch'), 'api');
});

const request = (n: number, visit: number, action: number | null, path: string): RequestRecord => ({
  n,
  state: visit,
  action,
  visit,
  method: 'GET',
  url: `http://localhost${path}`,
  origin: 'http://localhost',
  path,
  resource: 'fetch',
  kind: 'api',
  server_action: false,
  status: 200,
  blocked: false,
  failed: null,
  response: null,
  noise: null,
});

test('polling: a call made three times in one page load with no action is noise everywhere; twice, or after actions, is not', () => {
  const requests = [request(0, 0, null, '/api/notifications'), request(1, 0, null, '/api/notifications'), request(2, 0, null, '/api/notifications'), request(3, 0, null, '/api/products'), request(4, 0, null, '/api/products'), request(5, 1, 0, '/api/cart'), request(6, 1, 1, '/api/cart'), request(7, 1, 2, '/api/cart'), request(8, 2, null, '/api/notifications')];
  markPolling(requests);
  assert.deepEqual(requests.map((r) => r.noise?.label ?? '-'), ['noise', 'noise', 'noise', '-', '-', '-', '-', '-', 'noise']);
});
