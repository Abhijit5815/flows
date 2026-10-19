// Phase 1 exit: decide() p95 < 100 ms on CPU at every input size, trace writes included. Live: needs the real model.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INPUTS } from '../../spikes/latency/inputs.ts';
import { DEFAULT_THRESHOLD } from '../config/project.ts';
import { catalogueEntry } from '../embeddings/catalogue.ts';
import { LocalEmbeddingProvider } from '../embeddings/local.ts';
import { percentile } from '../shared/stats.ts';
import { liveModelsDir, liveSkip } from '../shared/testing/live.ts';
import { JsonlTraceSink } from '../trace/sink.ts';
import { DeciderV1 } from './decider.ts';
import { loadBuiltInTasks } from './task.ts';

const TARGET_P95_MS = 100;
const WARMUP_CALLS = 20;
const TIMED_CALLS = 300;

const dir = mkdtempSync(join(tmpdir(), 'flows-latency-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('live: decide() p95 is under 100 ms at every input size', { skip: liveSkip }, async (t) => {
  // Rules removed so every call embeds its input: the slow path, not the 1-in-a-few rule shortcut.
  const tasks = loadBuiltInTasks().map((task) => ({ ...task, rules: [] }));
  const decider = new DeciderV1({
    tasks,
    provider: new LocalEmbeddingProvider(catalogueEntry('bge-small-en-v1.5'), liveModelsDir),
    trace: new JsonlTraceSink(join(dir, 'trace.jsonl')),
    cacheDir: join(dir, 'index'),
    threshold: () => DEFAULT_THRESHOLD,
  });
  const labels = ['destructive', 'safe'];

  for (const [size, texts] of Object.entries(INPUTS)) {
    for (let i = 0; i < WARMUP_CALLS; i++) await decider.decide('destructive-risk', texts[i % texts.length], labels);
    const times: number[] = [];
    for (let i = 0; i < TIMED_CALLS; i++) {
      const start = performance.now();
      await decider.decide('destructive-risk', texts[i % texts.length], labels);
      times.push(performance.now() - start);
    }
    const p95 = percentile(times, 95);
    t.diagnostic(`${size}: p50 ${percentile(times, 50).toFixed(1)} ms | p95 ${p95.toFixed(1)} ms | p99 ${percentile(times, 99).toFixed(1)} ms | max ${percentile(times, 100).toFixed(1)} ms`);
    assert.ok(p95 < TARGET_P95_MS, `${size}: p95 ${p95.toFixed(1)} ms`);
  }
});
