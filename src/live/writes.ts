import { spawn } from 'node:child_process';
import { LiveError } from '../shared/errors.ts';

// Writes may reach an app only when it is a test one: this machine, a *.localhost or *.test name, or a host the project
// lists in explorer.test_hosts. A flag alone never makes a real site writable.
export function isTestHost(hostname: string, listed: readonly string[]): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.test') || listed.some((name) => name.toLowerCase() === host);
}

export function requireTestHost(url: string, listed: readonly string[]): void {
  const host = new URL(url).hostname;
  if (!isTestHost(host, listed)) throw new LiveError(`--allow-writes is only for test hosts, and ${host} is not one: it must be localhost, *.localhost, *.test, or listed in explorer.test_hosts`);
}

// explorer.reset, run in the project folder: the project's own command that puts its test data back.
export function runReset(command: string, cwd: string, log: (line: string) => void, env: Record<string, string> = {}): Promise<void> {
  log(`running: ${command}`);
  return new Promise((done, fail) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore', env: { ...process.env, ...env } });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new LiveError(`explorer.reset "${command}" exited with ${code}`))));
  });
}
