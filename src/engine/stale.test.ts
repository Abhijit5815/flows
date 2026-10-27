import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { STALE } from '../model/tags.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { saveAdded } from './edits.ts';
import { refreshFlows } from './engine.ts';
import { OptionalLlm } from './llm.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-stale-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("a person's flow citing code that is gone is tagged stale and kept; a generated flow that is gone is listed", async () => {
  const fixture = join(tmp, 'next-basic');
  cpSync(fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), fixture, { recursive: true });
  const project = addRepo(tempProject(join(tmp, 'project')), fixture, 'web');
  const repo = project.config.repos[0];
  const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };
  const deps = { decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => undefined), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  const scan = async () => {
    const { graph } = await scanRepo(project, repo);
    assert.ok(graph);
    return refreshFlows(project, repo, graph, deps);
  };

  const first = await scan();
  const click = first.flows.find((flow) => flow.name === 'User can add to cart');
  assert.ok(click);
  saveAdded(fixture, { ...click, id: 'ui-mine', name: 'My add to cart' });

  const unchanged = await scan();
  assert.deepEqual([unchanged.flows.filter((flow) => flow.tags.includes(STALE)).length, unchanged.gone.length], [0, 0], 'nothing changed, nothing is stale');

  rmSync(join(fixture, 'components', 'AddToCartButton.tsx'));
  const after = await scan();
  const mine = after.flows.find((flow) => flow.id === 'ui-mine');
  assert.ok(mine?.tags.includes(STALE), "the person's flow is kept and tagged stale");
  assert.ok(after.reasons['ui-mine'].some((reason) => /^stale: it cites .*AddToCartButton/.test(reason)));
  assert.deepEqual(after.gone.map((flow) => [flow.name, flow.reason]), [[click.name, 'gone from the code']]);
});
