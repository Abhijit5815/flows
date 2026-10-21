import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, generalize, pageRegex, routeRegex } from './paths.ts';

test('Next.js page patterns: dynamic segments, catch-alls and optional catch-alls', () => {
  assert.ok(pageRegex('/products/[id]').test('/products/1'));
  assert.ok(!pageRegex('/products/[id]').test('/products/1/reviews'));
  assert.ok(pageRegex('/docs/[...slug]').test('/docs/a/b'));
  assert.ok(!pageRegex('/docs/[...slug]').test('/docs'));
  assert.ok(pageRegex('/shop/[[...slug]]').test('/shop'));
  assert.ok(pageRegex('/shop/[[...slug]]').test('/shop/x/y'));
  assert.ok(pageRegex('/').test('/'));
  assert.ok(!pageRegex('/').test('/about'));
  assert.ok(pageRegex('/(shop)/cart').test('/cart'), 'a route group is not part of the URL');
});

test('Express route patterns: params, optional params, constrained params and wildcards', () => {
  assert.ok(routeRegex('/api/v1/orders/:orderId').test('/api/v1/orders/7'));
  assert.ok(!routeRegex('/api/v1/orders/:orderId').test('/api/v1/orders'));
  assert.ok(routeRegex('/users/:id(\\d+)').test('/users/42'));
  assert.ok(!routeRegex('/users/:id(\\d+)').test('/users/me'));
  assert.ok(routeRegex('/files/:name?').test('/files'));
  assert.ok(routeRegex('/files/:name?').test('/files/a.txt'));
  assert.ok(routeRegex('/assets/*').test('/assets/css/site.css'));
  assert.ok(routeRegex('/v1/games/:code').test('/v1/games/aB3dE9'));
});

test('the most specific pattern wins, and unmatched paths get their ids generalised', () => {
  assert.equal(bestMatch('/products/new', ['/products/[id]', '/products/new'], pageRegex), '/products/new');
  assert.equal(bestMatch('/users/me', ['/users/:id(\\d+)', '/users/me'], routeRegex), '/users/me');
  assert.equal(bestMatch('/about', ['/products/[id]'], pageRegex), undefined);
  assert.equal(generalize('/orders/123/items/9f86d0818847'), '/orders/:id/items/:id');
  assert.equal(generalize('/u/[email]/x7k2p9'), '/u/:id/:id');
  assert.equal(generalize('/blog/hello-world'), '/blog/hello-world');
});
