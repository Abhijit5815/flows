import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { FrameworkAdapter } from '../adapters/adapter.ts';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import type { Repo } from '../config/project.ts';

// PLAN.md Phase 2 stack detection: from package.json, the lockfile and the folders a framework needs.
// Shown by `flows stack`, and corrected with a framework pinned in .flows/config.json.
export type Stack = {
  framework: string | undefined; // adapter id; undefined when no adapter fits
  source: 'detected' | 'config';
  version: string | undefined; // exact from the lockfile when it has one, else the package.json range
  evidence: string[];
  warnings: string[];
};

type Match = { adapter: FrameworkAdapter; version: string; evidence: string[]; warnings: string[] };

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];

const PackageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

const VersionedSchema = z.record(z.string(), z.object({ version: z.string().optional() }));
const PackageLockSchema = z.object({ packages: VersionedSchema.optional(), dependencies: VersionedSchema.optional() });

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Workspaces keep one lockfile at the top, so look upward, but never past the git root.
function nearestLockfile(dir: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const found = LOCKFILES.map((name) => join(current, name)).find((file) => existsSync(file));
    if (found !== undefined || existsSync(join(current, '.git')) || dirname(current) === current) return found;
  }
}

// The installed version, when the lockfile names exactly one; `workspace` is the repo's folder relative to the lockfile.
function lockedVersion(lockfile: string, dependency: string, workspace: string): string | undefined {
  if (lockfile.endsWith('package-lock.json')) {
    const lock = PackageLockSchema.safeParse(readJson(lockfile));
    if (!lock.success) return undefined;
    const packages = lock.data.packages ?? {};
    return packages[join(workspace, 'node_modules', dependency)]?.version ?? packages[`node_modules/${dependency}`]?.version ?? lock.data.dependencies?.[dependency]?.version;
  }
  // shortcut: pnpm-lock.yaml and bun.lock are scanned for "<name>@<version>" rather than parsed, and yarn.lock
  // never matches, so it falls back to the package.json range; parse them properly if a version ever comes out wrong.
  const name = dependency.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[\\s'"])/?${name}@(\\d[^\\s:('",]*)`, 'gm');
  const versions = new Set(Array.from(readFileSync(lockfile, 'utf8').matchAll(pattern), (match) => match[1]));
  return versions.size === 1 ? [...versions][0] : undefined;
}

// Every adapter whose dependency the repo has, whatever its role; `notes` explains near misses.
export function detect(dir: string, adapters: readonly FrameworkAdapter[] = ADAPTERS): { matches: Match[]; notes: string[] } {
  const pkg = PackageJsonSchema.safeParse(readJson(join(dir, 'package.json')));
  if (!pkg.success) return { matches: [], notes: [`no readable package.json in ${dir}`] };
  const dependencies = { ...pkg.data.devDependencies, ...pkg.data.dependencies };
  const lockfile = nearestLockfile(dir);
  const matches: Match[] = [];
  const notes: string[] = [];
  for (const adapter of adapters) {
    const { dependency, testedMajors, needsOneOf = [] } = adapter.detection;
    const range = dependencies[dependency];
    if (range === undefined) continue;
    const folder = needsOneOf.find((path) => existsSync(join(dir, path)));
    if (needsOneOf.length > 0 && folder === undefined) {
      notes.push(`${dependency} is a dependency, but ${adapter.id} needs ${needsOneOf.map((path) => `${path}/`).join(' or ')} and there is none`);
      continue;
    }
    const locked = lockfile === undefined ? undefined : lockedVersion(lockfile, dependency, relative(dirname(lockfile), dir));
    const evidence = [`package.json: "${dependency}": "${range}"`];
    if (lockfile !== undefined && locked !== undefined) evidence.push(`${relative(dir, lockfile)}: ${dependency}@${locked}`);
    if (folder !== undefined) evidence.push(`${folder}/ folder`);
    const version = locked ?? range;
    const major = /\d+/.exec(version)?.[0];
    const tested = testedMajors.map((each) => `${each}.x`).join(', ');
    const warnings = major !== undefined && testedMajors.includes(Number(major)) ? [] : [`${adapter.id} is tested on ${dependency} ${tested}; this repo has "${version}"`];
    matches.push({ adapter, version, evidence, warnings });
  }
  return { matches, notes };
}

// The repo's stack: the user's pinned framework wins; otherwise the one adapter of the repo's role that detection found.
export function stackOf(root: string, repo: Repo, adapters: readonly FrameworkAdapter[] = ADAPTERS): Stack {
  const { matches, notes } = detect(resolve(root, repo.path), adapters);
  const forRole = matches.filter((match) => match.adapter.role === repo.role);
  if (repo.framework !== undefined) {
    const adapter = adapterFor(repo.framework, repo.role, adapters);
    const match = forRole.find((candidate) => candidate.adapter === adapter);
    return { framework: adapter.id, source: 'config', version: match?.version, evidence: ['set in .flows/config.json', ...(match?.evidence ?? [])], warnings: match?.warnings ?? [] };
  }
  if (forRole.length === 1) {
    const [{ adapter, version, evidence, warnings }] = forRole;
    return { framework: adapter.id, source: 'detected', version, evidence, warnings };
  }
  const fix = `set it with "flows stack set ${repo.path} <framework>"`;
  const warnings = forRole.length > 1
    ? [`${forRole.map((match) => match.adapter.id).join(' and ')} all match; ${fix}`]
    : [...notes, `no supported ${repo.role} framework found; if detection is wrong, ${fix}`];
  return { framework: undefined, source: 'detected', version: undefined, evidence: [], warnings };
}
