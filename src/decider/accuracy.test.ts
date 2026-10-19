// PLAN.md §8: Decider accuracy on labelled sets, measured on the held-out half. Live: needs the real model.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THRESHOLD } from '../config/project.ts';
import { catalogueEntry } from '../embeddings/catalogue.ts';
import { LocalEmbeddingProvider } from '../embeddings/local.ts';
import { liveModelsDir, liveSkip } from '../shared/testing/live.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { DeciderV1, UNKNOWN } from './decider.ts';
import { loadBuiltInTasks, testHalf } from './task.ts';

// Provisional gate from the Phase 1 plan: when the Decider does decide, it is right at least 90% of the time.
const GATE = 0.9;

// Types accepted below the gate for now; each reason says where the fix is planned. Their numbers still print.
const ACCEPTED_BELOW_GATE: Record<string, string> = {
  'destructive-risk': 'Phase 1 baseline is 82%; rebuilt from real sample-app texts in Phase 4 (PLAN.md)',
};

const cacheDir = mkdtempSync(join(tmpdir(), 'flows-accuracy-'));
after(() => rmSync(cacheDir, { recursive: true, force: true }));

const percent = (part: number, whole: number) => (whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(0)}%`);

test('live: Decider accuracy on the held-out half of each labelled set', { skip: liveSkip }, async (t) => {
  const tasks = loadBuiltInTasks();
  const trace = new MemoryTraceSink();
  const provider = new LocalEmbeddingProvider(catalogueEntry('bge-small-en-v1.5'), liveModelsDir);
  const decider = new DeciderV1({ tasks, provider, trace, cacheDir, threshold: () => DEFAULT_THRESHOLD });

  // One subtest per type, so one type's result never hides another's.
  for (const task of tasks) {
    await t.test(task.task, { todo: ACCEPTED_BELOW_GATE[task.task] }, async (st) => {
      const results = [];
      for (const item of testHalf(task)) results.push({ item, decision: await decider.decide(task.task, item.text, task.labels) });
      const decided = results.filter((result) => result.decision.label !== UNKNOWN);
      const correct = decided.filter((result) => result.decision.label === result.item.label);
      const byRule = trace.events.filter((event) => event.kind === 'decision' && event.decision_type === task.task && event.source === 'rule').length;
      st.diagnostic(
        `${results.length} held-out | decided ${decided.length} (coverage ${percent(decided.length, results.length)}) | ` +
          `right ${correct.length} (accuracy on decided ${percent(correct.length, decided.length)}) | overall ${percent(correct.length, results.length)} | by rule ${byRule}`,
      );
      for (const { item, decision } of results.filter((result) => result.decision.label !== result.item.label)) {
        const kind = decision.label === UNKNOWN ? 'unknown' : 'WRONG';
        st.diagnostic(`${kind}: "${item.text}" expected ${item.label}, got ${decision.label} (top p=${decision.prob.toFixed(2)})`);
      }
      assert.ok(decided.length === 0 || correct.length / decided.length >= GATE, `accuracy on decided items is below ${GATE}`);
    });
  }
});
