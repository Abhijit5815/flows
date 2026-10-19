import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Installed or generated folders: never source, and often huge.
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);

// Every file in a repo folder, as sorted paths relative to it. Symlinks are left out, so nothing outside is read.
export function listFiles(dir: string): string[] {
  return (fromGit(dir) ?? walk(dir, dir)).sort();
}

// git leaves out what .gitignore lists (build output, env files) and keeps new files that aren't committed yet.
function fromGit(dir: string): string[] | undefined {
  let output: string;
  try {
    // A repo's own git config can name a command for ls-files to run (core.fsmonitor); turning it off keeps
    // the "no project code is executed" rule.
    output = execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 28,
    });
  } catch {
    return undefined; // not in a git repo, or no git installed
  }
  // Tracked files can be deleted on disk, and submodules appear as folders.
  return output.split('\0').filter((path) => path !== '' && lstatSync(join(dir, path), { throwIfNoEntry: false })?.isFile());
}

function walk(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(root, path);
    return entry.isFile() ? [relative(root, path)] : [];
  });
}
