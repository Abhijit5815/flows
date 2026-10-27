// The CLI answers a user's mistakes with one line, the way to the fix and exit code 1: never a stack, never silence.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./main.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-cli-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const flows = (dir: string, ...args: string[]) => {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, FLOWS_HOME: join(tmp, 'home') } });
  return { status: run.status, out: run.stdout.trim(), err: run.stderr.replace(/^.*ExperimentalWarning.*\n?/gm, '').trim() };
};

test("a user's mistakes get one line and exit 1", () => {
  const dir = join(tmp, 'project');
  mkdirSync(join(dir, 'web'), { recursive: true });
  assert.deepEqual(flows(dir, '--version'), { status: 1, out: '', err: 'flows: unknown option --version; see "flows help"' });
  assert.equal(flows(dir, 'init').status, 0);
  const none = 'flows: no repos registered yet; run "flows repo add <path> --role web|api" first';
  for (const args of [['scan'], ['show', 'flows'], ['export']]) assert.deepEqual(flows(dir, ...args), { status: 1, out: '', err: none }, args.join(' '));
  assert.deepEqual(flows(dir, 'repo', 'add', 'web', '--role', 'backend'), { status: 1, out: '', err: 'flows: the role must be web or api, not "backend"' });
  assert.equal(flows(dir, 'repo', 'add', 'web', '--role', 'web').status, 0);
  const bogus = flows(dir, 'show', 'bogus');
  assert.equal(bogus.status, 1);
  assert.match(bogus.err, /^flows: there is no "bogus" to show; one of: flows, .*routes/);
  assert.deepEqual(flows(dir, 'show', 'flows'), { status: 0, out: 'web  web: no flows yet; run "flows scan"', err: '' });
});
