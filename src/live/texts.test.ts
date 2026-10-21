import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { tempProject } from '../shared/testing/project.ts';
import { gate, type Candidate } from './actions.ts';
import type { State } from './run.ts';
import { sourceTexts } from './texts.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-texts-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("a live control is rated as the source flows it matches: a link as its page's view, a form or click as its own flow", async () => {
  const project = tempProject(join(tmp, 'project'));
  const repo = addRepo(project, fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), 'web').config.repos[0];
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  const source = sourceTexts([graph]);
  assert.deepEqual(source.link('/products'), ['page: /products (product card) -> GET /api/products']);
  assert.deepEqual(source.form('/account', ['name', 'email', 'street', 'city'], 'Save'), ['form: profile form (name, email, street, city) -> handle submit -> PATCH /api/me on /account']);
  assert.deepEqual(source.click('/products', 'Add to cart'), ['click: add to cart button on click -> POST /api/cart/items on /products']);
  assert.deepEqual(source.click('/products', 'Compare'), [], 'what source lacks keeps its live text');
});

test('the least safe of the texts decides, and the reason names the source flow it came from', async () => {
  const decider: Decider = {
    decide: async (_task, text) =>
      text.includes('PATCH') ? { label: 'unknown', prob: 0.6, all_probs: { safe: 0.6, destructive: 0.4 }, version: 'stub' } : { label: 'safe', prob: 0.95, all_probs: { safe: 0.95, destructive: 0.05 }, version: 'stub' },
  };
  const state = { forms: [] } as unknown as State;
  const candidate: Candidate = {
    kind: 'click',
    element: { text: 'Save', selector: 'id:save', stable: true },
    text: 'click: save on /account',
    rated: ['click: save -> GET /x on /account', 'form: profile -> PATCH /api/me on /account'],
    fields: [],
    key: 'k',
  };
  const { decision, taken } = await gate(candidate, state, { decider, minSafeProb: 0.8, origin: 'http://localhost' });
  assert.equal(taken, false);
  assert.equal(decision.reason, 'the Decider was unsure (as the source flow "form: profile -> PATCH /api/me on /account")');
});
