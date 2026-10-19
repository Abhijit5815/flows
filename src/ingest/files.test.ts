import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listFiles } from './files.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-files-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function makeFiles(root: string, paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '');
  }
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { cwd: dir, stdio: 'ignore' });

test('outside git: walks the folder, skipping installed and generated folders and symlinks', () => {
  const root = join(tmp, 'plain');
  makeFiles(root, ['package.json', 'src/app/page.tsx', 'node_modules/next/index.js', '.next/server.js', 'dist/main.js', 'build/x.js', 'coverage/y.js']);
  symlinkSync('/etc/hosts', join(root, 'src/hosts'));
  assert.deepEqual(listFiles(root), ['package.json', 'src/app/page.tsx']);
});

test('in git: tracked and new files, minus ignored ones and deleted ones, relative to the folder asked for', () => {
  const root = join(tmp, 'repo');
  makeFiles(root, ['.gitignore', 'web/src/a.ts', 'web/src/gone.ts', 'web/.env.local', 'api/b.ts']);
  writeFileSync(join(root, '.gitignore'), '.env.local\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  rmSync(join(root, 'web/src/gone.ts'));
  makeFiles(root, ['web/src/new.ts']);
  assert.deepEqual(listFiles(join(root, 'web')), ['src/a.ts', 'src/new.ts']);
});

// A repo can set core.fsmonitor to a command that git runs during ls-files. Listing files must never run it.
test("listing files never runs a command from the repo's own git config", () => {
  const root = join(tmp, 'hostile');
  const marker = join(tmp, 'fsmonitor-ran');
  makeFiles(root, ['a.ts']);
  writeFileSync(join(tmp, 'hook.sh'), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(tmp, 'hook.sh'), 0o755);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  git(root, 'config', 'core.fsmonitor', join(tmp, 'hook.sh'));
  assert.deepEqual(listFiles(root), ['a.ts']);
  assert.equal(existsSync(marker), false, 'the repo-configured fsmonitor command ran');
});
