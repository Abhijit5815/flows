import { execFileSync } from 'node:child_process';

// Where a repo's code stands, so a scan can say what changed since the last one. Undefined outside a git repo.
export type GitState = { commit: string; branch: string | null; dirty: boolean };

// core.fsmonitor off, as in files.ts: a repo's own config must not make git run a command.
const git = (dir: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
};

export function gitState(dir: string): GitState | undefined {
  const commit = git(dir, ['rev-parse', 'HEAD']);
  if (commit === undefined || commit === '') return undefined;
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { commit, branch: branch === undefined || branch === 'HEAD' ? null : branch, dirty: (git(dir, ['status', '--porcelain', '--', '.', ':(exclude).flows']) ?? '') !== '' };
}

// How many files differ between two commits; undefined when git can't say (a commit that was rewritten away).
export function filesChanged(dir: string, from: string, to: string): number | undefined {
  const out = git(dir, ['diff', '--name-only', from, to]);
  return out === undefined ? undefined : out === '' ? 0 : out.split('\n').length;
}
