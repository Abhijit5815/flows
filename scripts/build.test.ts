// The package build: plain JavaScript that Node runs from an installed package, with its data files and the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

test('the build makes a runnable CLI, ships the data files and the page, and no TypeScript', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build.ts')], { stdio: 'pipe' });
  const cli = join(dist, 'cli', 'main.js');
  assert.ok(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n'));
  assert.match(execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }), /^usage: flows <command>/);
  for (const file of ['decider/tasks/destructive-risk.json', 'embeddings/catalogue.json', 'adapters/express/rules.json', 'ui/web/app.js', 'ui/web/app.css', 'index.js', 'index.d.ts']) assert.ok(existsSync(join(dist, file)), file);
  assert.ok(!existsSync(join(dist, 'ui', 'web', 'app.tsx')) && !existsSync(join(dist, 'shared', 'testing')));
  assert.doesNotMatch(readFileSync(cli, 'utf8'), /from '\.[^']*\.ts'/, 'imports point at .js files');
});
