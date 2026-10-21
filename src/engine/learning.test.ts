import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { loadBuiltInTasks } from '../decider/task.ts';
import { lookup } from '../graph/lookup.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { addRule, today } from '../rules/learned.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { deciderText } from './describe.ts';
import { saveOverride } from './edits.ts';
import { buildFlows } from './engine.ts';
import { learnedExamples, withLearned } from './learning.ts';
import { OptionalLlm } from './llm.ts';
import { saveFlows } from './store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-learning-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("people's categories and correct verdicts become Decider examples; wrong and never teach nothing", async () => {
  const fixture = join(tmp, 'next-basic');
  cpSync(fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), fixture, { recursive: true });
  const project = addRepo(tempProject(join(tmp, 'project')), fixture, 'web');
  const repo = project.config.repos[0];
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };
  const deps = { decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => undefined), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  const set = await buildFlows(graph, { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } }, deps);
  saveFlows(project, repo, set);
  const [products, cart, account] = ['Open /products', 'Open /cart', 'Open /account'].map((name) => set.flows.find((flow) => flow.name === name));
  assert.ok(products && cart && account);
  saveOverride(fixture, products.id, { category: 'browse', enabled: true }, products.version);
  addRule(fixture, { type: 'feedback', flow: cart.id, kind: 'wrong', added: today() });
  addRule(fixture, { type: 'feedback', flow: account.id, kind: 'never', added: today() });
  // The verdict counts once the scan after it has the flow enabled.
  const rebuilt = await buildFlows(graph, { verdicts: new Map([[products.id, 'correct' as const]]), edits: { schema_version: 0, overrides: { [products.id]: { category: 'browse', enabled: true, version: 2, edited: new Date().toISOString() } }, added: [] } }, deps);
  saveFlows(project, repo, rebuilt);
  addRule(fixture, { type: 'feedback', flow: products.id, kind: 'correct', added: today() });

  const text = deciderText(products, lookup(graph));
  assert.deepEqual(learnedExamples(project), { 'flow-category': { browse: [text] }, 'destructive-risk': { safe: [text] } });

  const tasks = withLearned(loadBuiltInTasks(), learnedExamples(project));
  const examples = (task: string, label: string) => tasks.find((candidate) => candidate.task === task)?.examples[label] ?? [];
  assert.ok(examples('flow-category', 'browse').includes(text));
  assert.ok(examples('destructive-risk', 'safe').includes(text));
  assert.ok(!examples('destructive-risk', 'destructive').includes(deciderText(cart, lookup(graph))));
});

test('a learned text the task already has, or a label it lacks, is left out', () => {
  const [risk] = loadBuiltInTasks().filter((task) => task.task === 'destructive-risk');
  const known = risk.labelled[0].text;
  const [merged] = withLearned([risk], { 'destructive-risk': { safe: [known, 'click: fresh text on /x'], maybe: ['click: other on /y'] } });
  assert.deepEqual(merged.examples.safe.slice(-1), ['click: fresh text on /x']);
  assert.equal(merged.examples.maybe, undefined);
  assert.equal(merged.examples.safe.length, risk.examples.safe.length + 1);
});
