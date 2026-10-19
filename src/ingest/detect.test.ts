import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FrameworkAdapter } from '../adapters/adapter.ts';
import { ConfigError } from '../shared/errors.ts';
import { stackOf } from './detect.ts';

const samples = fileURLToPath(new URL('../../fixtures/samples/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-detect-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function app(name: string, dependencies: Record<string, string>, folders: string[] = []): string {
  const dir = join(tmp, name);
  for (const folder of folders) mkdirSync(join(dir, folder), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true }); // stops the lockfile search here
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }));
  return dir;
}

// The three sample apps: lockfile at the workspace root (chessu), in the app folder (next-learn), or none (starter).
const sampleCases = [
  { path: 'chessu/client', role: 'web', framework: 'nextjs-app', version: '14.2.5', evidence: ['../pnpm-lock.yaml: next@14.2.5', 'src/app/ folder'] },
  { path: 'chessu/server', role: 'api', framework: 'express', version: '4.19.2', evidence: ['../pnpm-lock.yaml: express@4.19.2'] },
  { path: 'next-learn/dashboard/final-example', role: 'web', framework: 'nextjs-app', version: '14.0.2', evidence: ['package-lock.json: next@14.0.2', 'app/ folder'] },
  { path: 'typescript-express-starter/lib/default', role: 'api', framework: 'express', version: '^4.18.1', evidence: ['package.json: "express": "^4.18.1"'] },
] as const;

for (const expected of sampleCases) {
  test(`detects ${expected.framework} ${expected.version} in ${expected.path}`, () => {
    const stack = stackOf(samples, { path: expected.path, role: expected.role });
    assert.equal(stack.framework, expected.framework);
    assert.equal(stack.source, 'detected');
    assert.equal(stack.version, expected.version);
    for (const line of expected.evidence) assert.ok(stack.evidence.includes(line), `missing "${line}" in ${JSON.stringify(stack.evidence)}`);
    assert.deepEqual(stack.warnings, []);
  });
}

test('a Next.js app without an app/ folder (Pages Router) is not taken for the App Router adapter', () => {
  const dir = app('pages-router', { next: '^14.1.0' }, ['pages']);
  const stack = stackOf(dir, { path: '.', role: 'web' });
  assert.equal(stack.framework, undefined);
  assert.match(stack.warnings.join('\n'), /nextjs-app needs app\/ or src\/app\/ and there is none/);
});

test('a version the adapter was not built on is used, with a warning', () => {
  const stack = stackOf(app('express5', { express: '^5.0.1' }), { path: '.', role: 'api' });
  assert.equal(stack.framework, 'express');
  assert.match(stack.warnings.join('\n'), /tested on express 4\.x; this repo has "\^5\.0\.1"/);
});

test('the right role only: an Express dependency does not make a web repo an Express app', () => {
  const stack = stackOf(app('custom-server', { express: '^4.19.2', next: '^14.2.0' }, ['app']), { path: '.', role: 'web' });
  assert.equal(stack.framework, 'nextjs-app');
});

test('a framework pinned in the config wins over detection, and must exist and fit the role', () => {
  const dir = app('pinned', { express: '^4.19.2' });
  const stack = stackOf(dir, { path: '.', role: 'api', framework: 'express' });
  assert.equal(stack.source, 'config');
  assert.equal(stack.evidence[0], 'set in .flows/config.json');

  const bare = join(tmp, 'no-package-json');
  mkdirSync(bare);
  assert.equal(stackOf(bare, { path: '.', role: 'api', framework: 'express' }).framework, 'express');
  assert.throws(() => stackOf(dir, { path: '.', role: 'api', framework: 'koa' }), (e) => e instanceof ConfigError && /unknown framework "koa"/.test(e.message));
  assert.throws(() => stackOf(dir, { path: '.', role: 'api', framework: 'nextjs-app' }), (e) => e instanceof ConfigError && /reads web repos/.test(e.message));
});

test('two adapters of one role matching is reported, not guessed', () => {
  const twin = (id: string): FrameworkAdapter => ({ id, role: 'api', detection: { dependency: 'express', testedMajor: 4 } });
  const stack = stackOf(app('ambiguous', { express: '^4.19.2' }), { path: '.', role: 'api' }, [twin('a'), twin('b')]);
  assert.equal(stack.framework, undefined);
  assert.match(stack.warnings.join('\n'), /a and b all match/);
});
