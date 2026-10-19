import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRepo } from '../config/project.ts';
import { tempProject } from '../shared/testing/project.ts';
import { scanRepo } from './pipeline.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-pipeline-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// PLAN.md Phase 2: static parsing only. The app below writes a marker if any of its code or package scripts run.
test('scanning reads the repo but never runs its code or its package scripts', async () => {
  const marker = join(tmp, 'project-code-ran');
  const touch = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  const app = join(tmp, 'hostile-app');
  write(app, {
    'package.json': JSON.stringify({ dependencies: { express: '^4.19.2' }, scripts: { preinstall: `node -e "${touch}"`, prepare: `node -e "${touch}"`, postinstall: `node -e "${touch}"` } }),
    'src/side-effect.ts': `${touch};\nexport const loaded = true;\n`,
    'src/server.ts': "import express from 'express';\nimport { loaded } from './side-effect';\n\nconst app = express();\napp.get('/ping', (req, res) => res.json({ loaded }));\n",
  });
  const project = tempProject(join(tmp, 'project'));
  const { graph } = await scanRepo(project, addRepo(project, app, 'api').config.repos[0]);
  assert.deepEqual(graph?.nodes.filter((node) => node.kind === 'route').map((node) => node.id), ['api:route:GET /ping']);
  assert.equal(existsSync(marker), false, 'scanning ran code from the repo');
});

test('a second scan parses no files; an edited file is the only one parsed again', async () => {
  const app = join(tmp, 'cached-app');
  write(app, {
    'package.json': JSON.stringify({ dependencies: { express: '^4.19.2' } }),
    'src/server.ts': "import express from 'express';\nimport { list } from './handlers';\n\nconst app = express();\napp.get('/items', list);\n",
    'src/handlers.ts': "export const list = (req: unknown, res: { json(body: unknown): void }) => res.json({ items: [] });\n",
  });
  const project = tempProject(join(tmp, 'cached'));
  const repo = addRepo(project, app, 'api').config.repos[0];
  assert.deepEqual((await scanRepo(project, repo)).coverage.parsed, ['src/handlers.ts', 'src/server.ts']);
  assert.deepEqual((await scanRepo(project, repo)).coverage.parsed, []);
  writeFileSync(join(app, 'src/handlers.ts'), "export const list = (req: unknown, res: { json(body: unknown): void }) => res.json({ items: [], total: 0 });\n");
  const again = await scanRepo(project, repo);
  assert.deepEqual(again.coverage.parsed, ['src/handlers.ts']);
  const response = again.graph?.nodes.find((node) => node.kind === 'response');
  assert.deepEqual(response?.kind === 'response' ? response.attrs.fields : [], ['items', 'total']);
});
