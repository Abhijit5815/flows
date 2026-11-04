import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import type { LlmGateway, LlmRequest } from '../llm/gateway.ts';
import { OutputValidationError } from '../shared/errors.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { refreshFlows } from './engine.ts';
import { OptionalLlm } from './llm.ts';
import { carryQa, qaFlows } from './qa.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-qa-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('the AI reads a flow as a tester would, its review is kept while the flow is unchanged, and dropped when it changes', async () => {
  const fixture = join(tmp, 'express-basic');
  cpSync(fileURLToPath(new URL('../../fixtures/apps/express-basic/', import.meta.url)), fixture, { recursive: true });
  const project = addRepo(tempProject(join(tmp, 'project')), fixture, 'api');
  const repo = project.config.repos[0];
  const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };
  const prompts: string[] = [];
  const gateway: LlmGateway = {
    model: 'stub',
    completeJson: async <T,>(request: LlmRequest<T>): Promise<T> => {
      if (request.purpose === 'flow-qa') {
        prompts.push(request.prompt);
        return request.schema.parse({ verdict: 'needs-work', functional: 'The status is checked.', end_to_end: 'It needs a sign-in first.', gaps: ['no failure case'] });
      }
      throw new OutputValidationError('only QA is answered in this test'); // names stay from source, the AI stays on
    },
  };
  const llm = new OptionalLlm(gateway, join(tmp, 'llm.json'), () => undefined);
  const deps = { decider: unsure, grounding: unsure, llm, trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  const set = await refreshFlows(project, repo, graph, deps, true);
  const target = set.flows[0];

  assert.equal(await qaFlows(set, new Set([target.id]), llm, '2026-01-01T00:00:00Z'), 1);
  assert.equal(set.qa[target.id].verdict, 'needs-work');
  assert.match(prompts[0], new RegExp(`Flow: ${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(prompts[0], /Steps:/);
  assert.equal(Object.keys(set.qa).length, 1, 'only the flow asked about is reviewed');

  assert.deepEqual(Object.keys(carryQa(set, set)), [target.id], 'unchanged: the review stays');
  const edited = { ...set, flows: set.flows.map((flow) => (flow.id === target.id ? { ...flow, steps: flow.steps.map((step) => ({ ...step, claim: `${step.claim} and more` })) } : flow)) };
  assert.deepEqual(carryQa(edited, set), {}, 'a flow that changed is no longer shown as reviewed');
});
