// The package build (PLAN.md Phase 7): Node won't run .ts files from an installed package, so dist/ gets plain
// JavaScript from tsc (imports rewritten to .js), the JSON data files next to the code that reads them, the review
// page bundled ahead of time, and a CLI that runs as `flows`.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PAGE_BUNDLE } from '../src/ui/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
// Data files (Decider tasks, adapter rules, the model catalogue), not the page's sources or test helpers.
cpSync(join(root, 'src'), dist, {
  recursive: true,
  filter: (path) => (statSync(path).isDirectory() ? !/[\\/](web|testing)$/.test(path) : path.endsWith('.json')),
});
await build({ ...PAGE_BUNDLE, entryPoints: [join(root, 'src', 'ui', 'web', 'app.tsx')], outdir: join(dist, 'ui', 'web'), minify: true });
const cli = join(dist, 'cli', 'main.js');
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, 'utf8')}`);
chmodSync(cli, 0o755);
console.log(`built ${dist}`);
