import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { refreshFlows } from './engine.ts';
import { OptionalLlm } from './llm.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-since-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a scan says what is new, changed or renamed since the one before, and a person\'s edit does not wipe it', async () => {
  const fixture = join(tmp, 'next-basic');
  cpSync(fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), fixture, { recursive: true });
  const project = addRepo(tempProject(join(tmp, 'project')), fixture, 'web');
  const repo = project.config.repos[0];
  const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };
  const deps = { decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => undefined), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  const scan = async (isScan = true) => {
    const { graph } = await scanRepo(project, repo);
    assert.ok(graph);
    return refreshFlows(project, repo, graph, deps, isScan);
  };

  const first = await scan();
  assert.equal(first.since?.first, true);
  assert.deepEqual(first.since?.changes, {}, 'the first scan has nothing to compare with');

  const same = await scan();
  assert.deepEqual([same.since?.first, same.since?.changes], [false, {}], 'nothing changed');

  mkdirSync(join(fixture, 'app', 'about'));
  writeFileSync(join(fixture, 'app', 'about', 'page.tsx'), 'export default function About() { return <h1>About us</h1>; }\n');
  const added = await scan();
  const fresh = added.flows.filter((flow) => added.since?.changes[flow.id] === 'new');
  assert.deepEqual(fresh.map((flow) => flow.steps[0].check?.kind === 'ui' ? flow.steps[0].check.page : undefined), ['/about']);
  assert.equal(Object.values(added.since?.changes ?? {}).filter((kind) => kind === 'changed').length, 0);

  const edited = await scan(false);
  assert.deepEqual(edited.since?.changes, added.since?.changes, 'a person\'s edit or a live run keeps the marks');
  const later = await scan();
  assert.deepEqual(later.since?.changes, added.since?.changes, 'unseen flows stay marked at the next scan');

  renameSync(join(fixture, 'app', 'about'), join(fixture, 'app', 'about-us'));
  const renamed = await scan();
  assert.ok(renamed.flows.some((flow) => flow.steps[0].check?.kind === 'ui' && flow.steps[0].check.page === '/about-us'));
  assert.ok(!renamed.flows.some((flow) => flow.steps[0].check?.kind === 'ui' && flow.steps[0].check.page === '/about'), 'the old flow is not kept beside it');
});

test('a route whose path was renamed, with the same handler, is one updated flow and not a duplicate beside a gone one', async () => {
  const fixture = join(tmp, 'express-basic');
  cpSync(fileURLToPath(new URL('../../fixtures/apps/express-basic/', import.meta.url)), fixture, { recursive: true });
  const project = addRepo(tempProject(join(tmp, 'project-api')), fixture, 'api');
  const repo = project.config.repos[0];
  const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };
  const deps = { decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm2.json'), () => undefined), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  const scan = async () => {
    const { graph } = await scanRepo(project, repo);
    assert.ok(graph);
    return refreshFlows(project, repo, graph, deps, true);
  };
  await scan();
  const file = join(fixture, 'src', 'routes', 'orders.routes.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace("router.get(ORDER_ID, orders.getById);", "router.get('/by-id/:orderId', orders.getById);"));
  const after = await scan();
  const updated = Object.entries(after.since?.replaces ?? {});
  assert.equal(updated.length, 1, JSON.stringify({ changes: after.since?.changes, gone: after.gone }));
  assert.match(updated[0][1].name, /order/i);
  assert.equal(after.since?.changes[updated[0][0]], 'changed');
  assert.deepEqual(after.gone, [], 'the old flow is not listed as gone: it was updated');
});
