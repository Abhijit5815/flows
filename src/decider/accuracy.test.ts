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
import { evaluateTask } from './eval.ts';
import { loadBuiltInTasks } from './task.ts';

// Provisional gate from the Phase 1 plan: when the Decider does decide, it is right at least 90% of the time.
const GATE = 0.9;

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
    await t.test(task.task, async (st) => {
      const report = await evaluateTask(decider, task);
      const byRule = trace.events.filter((event) => event.kind === 'decision' && event.decision_type === task.task && event.source === 'rule').length;
      st.diagnostic(
        `${report.heldOut} held-out | decided ${report.decided} (coverage ${percent(report.decided, report.heldOut)}) | ` +
          `right ${report.right} (accuracy on decided ${percent(report.right, report.decided)}) | overall ${percent(report.right, report.heldOut)} | by rule ${byRule} | ECE ${report.ece.toFixed(2)}`,
      );
      for (const miss of report.misses) st.diagnostic(`${miss.got === UNKNOWN ? 'unknown' : 'WRONG'}: "${miss.text}" expected ${miss.expected}, got ${miss.got} (top p=${miss.prob.toFixed(2)})`);
      assert.ok(report.accuracy >= GATE, `accuracy on decided items is below ${GATE}`);
    });
  }
});
