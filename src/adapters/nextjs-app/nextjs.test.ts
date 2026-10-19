import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../../config/project.ts';
import { scanRepo } from '../../ingest/pipeline.ts';
import { tempProject } from '../../shared/testing/project.ts';
import { matcherRegex, nextAppAdapter, routePath } from './nextjs.ts';
import { uiViews } from './views.ts';

const fixture = fileURLToPath(new URL('../../../fixtures/apps/next-basic/', import.meta.url));
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'flows-next-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function scanFixture(name: string, adapters = [nextAppAdapter]) {
  const project = tempProject(join(tmp, name));
  return scanRepo(project, addRepo(project, fixture, 'web').config.repos[0], { adapters });
}

const byKey = <T extends Record<string, unknown>>(key: keyof T, views: T[]) => [...views].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

test('next fixture: every page and layout, with layouts, guards, components, forms, actions and API calls', async () => {
  const { graph, coverage } = await scanFixture('fixture');
  assert.ok(graph);
  const { pages, layouts } = uiViews(graph);
  assert.deepEqual(byKey('page', pages), byKey('page', expected.pages));
  assert.deepEqual(byKey('layout', layouts), byKey('layout', expected.layouts));
  assert.deepEqual(coverage.unrecognised.map((note) => `${note.file}:${note.line}`).sort(), expected.unrecognised);
});

// The fixture test has to be able to fail: without the API-call rules, the unreached fetch in lib/legacy.ts is
// no longer reported.
test('a broken rule fails the fixture: without the api-call rules, the unreached call goes unreported', async () => {
  const { coverage } = await scanFixture('broken', [{ ...nextAppAdapter, rules: nextAppAdapter.rules.filter((rule) => rule.id !== 'api-call') }]);
  const notes = coverage.unrecognised.map((note) => `${note.file}:${note.line}`).sort();
  assert.notDeepEqual(notes, expected.unrecognised);
  assert.deepEqual(expected.unrecognised.filter((note: string) => !notes.includes(note)), ['lib/legacy.ts:5']);
});

test('route groups add nothing to the path; dynamic and catch-all segments stay', () => {
  assert.equal(routePath([]), '/');
  assert.equal(routePath(['(shop)', 'products', '[id]']), '/products/[id]');
  assert.equal(routePath(['dashboard', '(overview)']), '/dashboard');
  assert.equal(routePath(['docs', '[...slug]']), '/docs/[...slug]');
});

test('middleware matchers: path patterns and regular expressions', () => {
  assert.ok(matcherRegex('/account/:path*').test('/account'));
  assert.ok(matcherRegex('/account/:path*').test('/account/orders/x'));
  assert.ok(!matcherRegex('/account/:path*').test('/accounts'));
  assert.ok(matcherRegex('/cart').test('/cart'));
  assert.ok(!matcherRegex('/cart').test('/cart/x'));
  assert.ok(matcherRegex('/((?!api|_next/static|_next/image|.*\\.png$).*)').test('/dashboard/invoices'));
  assert.ok(!matcherRegex('/((?!api|_next/static|_next/image|.*\\.png$).*)').test('/api/x'));
});
