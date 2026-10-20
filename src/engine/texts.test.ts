// PLAN.md Phase 4: destructive-risk is built from real texts. Its examples are what the engine says about our two
// fixture apps and its labelled set what it says about the three sample apps, so a change to the text format shows
// up here instead of silently testing the Decider on texts the engine no longer writes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../config/project.ts';
import { loadBuiltInTasks } from '../decider/task.ts';
import { lookup } from '../graph/lookup.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { tempProject } from '../shared/testing/project.ts';
import { candidates } from './candidates.ts';
import { deciderText } from './describe.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-texts-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function textsOf(folders: readonly (readonly [string, 'web' | 'api'])[]): Promise<string[]> {
  const texts: string[] = [];
  for (const [folder, role] of folders) {
    const project = tempProject(join(tmp, folder.replace(/\W/g, '-')));
    const { graph } = await scanRepo(project, addRepo(project, join(fixtures, folder), role).config.repos[0]);
    assert.ok(graph, folder);
    texts.push(...candidates(graph).flows.map((flow) => deciderText(flow, lookup(graph))));
  }
  return texts;
}

test('destructive-risk: examples come from the fixture apps and the labelled set from the sample apps, word for word', async () => {
  const task = loadBuiltInTasks().find((candidate) => candidate.task === 'destructive-risk');
  assert.ok(task);
  const fromFixtures = await textsOf([['apps/express-basic', 'api'], ['apps/next-basic', 'web']]);
  const fromSamples = await textsOf([
    ['samples/chessu/client', 'web'],
    ['samples/chessu/server', 'api'],
    ['samples/next-learn/dashboard/final-example', 'web'],
    ['samples/typescript-express-starter/lib/default', 'api'],
  ]);
  assert.deepEqual(Object.values(task.examples).flat().sort(), [...fromFixtures].sort());
  assert.deepEqual(task.labelled.map((item) => item.text), fromSamples);
});
