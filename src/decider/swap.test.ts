// Phase 1 exit: a model swap works end to end. Live: downloads BGE-M3 (2.27 GB) on its first run.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THRESHOLD } from '../config/project.ts';
import { catalogueEntry } from '../embeddings/catalogue.ts';
import { LocalEmbeddingProvider } from '../embeddings/local.ts';
import { liveModelsDir, liveSkip } from '../shared/testing/live.ts';
import { JsonlTraceSink, readTrace } from '../trace/sink.ts';
import { DeciderV1 } from './decider.ts';
import { loadBuiltInTasks } from './task.ts';

const dir = mkdtempSync(join(tmpdir(), 'flows-swap-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('live: swapping bge-small for BGE-M3 rebuilds the index, refits calibration and shows in the trace', { skip: liveSkip }, async (t) => {
  const tasks = loadBuiltInTasks();
  const trace = join(dir, 'trace.jsonl');
  const cacheDir = join(dir, 'index');
  const deciderFor = (model: string) =>
    new DeciderV1({ tasks, provider: new LocalEmbeddingProvider(catalogueEntry(model), liveModelsDir), trace: new JsonlTraceSink(trace), cacheDir, threshold: () => DEFAULT_THRESHOLD });
  const cacheKeys = () => ['examples', 'calibration'].map((part) => JSON.parse(readFileSync(join(cacheDir, `destructive-risk.${part}.json`), 'utf8')).key as string);
  const input = 'button: Confirm and charge my card';
  const labels = ['destructive', 'safe'];

  const small = await deciderFor('bge-small-en-v1.5').decide('destructive-risk', input, labels);
  const smallKeys = cacheKeys();
  const m3 = await deciderFor('bge-m3').decide('destructive-risk', input, labels);
  const m3Keys = cacheKeys();

  t.diagnostic(`bge-small: ${small.label} (p=${small.prob.toFixed(2)}) ${small.version}`);
  t.diagnostic(`bge-m3:    ${m3.label} (p=${m3.prob.toFixed(2)}) ${m3.version}`);
  assert.match(small.version, /bge-small-en-v1\.5/);
  assert.match(m3.version, /bge-m3/);
  assert.notEqual(m3Keys[0], smallKeys[0], 'example vectors were rebuilt for the new model');
  assert.notEqual(m3Keys[1], smallKeys[1], 'calibration was refitted for the new model');
  const versions = new Set(readTrace(trace).map((event) => event.model_version));
  assert.deepEqual(versions, new Set([small.version, m3.version]), 'the trace shows which model made each decision');
});
