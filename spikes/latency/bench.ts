// Phase 0 spike: how fast is embed + match on CPU for each candidate model?
// It calls Transformers.js directly on purpose; Phase 1 designs the embedding-provider interface from these numbers.
import { pipeline } from '@huggingface/transformers';
import os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { percentile } from '../../src/shared/stats.ts';
import { INPUTS, type InputSize } from './inputs.ts';

type Candidate = {
  model: string;
  revision: string; // commit read on 2026-10-19
  dtype: 'fp32' | 'q8';
  pooling: 'cls' | 'last_token'; // from each model's 1_Pooling/config.json
  source: string;
  externalData?: boolean; // weights live in a separate .onnx_data file
};

const CANDIDATES: Candidate[] = [
  { model: 'BAAI/bge-small-en-v1.5', revision: '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a', dtype: 'fp32', pooling: 'cls', source: 'publisher' },
  { model: 'Xenova/bge-small-en-v1.5', revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3', dtype: 'q8', pooling: 'cls', source: 'copy, no license stated' },
  { model: 'BAAI/bge-m3', revision: '5617a9f61b028005a4858fdac845db406aefb181', dtype: 'fp32', pooling: 'cls', source: 'publisher', externalData: true },
  { model: 'Xenova/bge-m3', revision: '4de13258303883538bd53b696b452bf8099f0858', dtype: 'q8', pooling: 'cls', source: 'copy, states MIT' },
  { model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', revision: 'c25a394dd583836952667c12f008335071b3f43d', dtype: 'fp32', pooling: 'last_token', source: 'copy, no license stated', externalData: true },
  { model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', revision: 'c25a394dd583836952667c12f008335071b3f43d', dtype: 'q8', pooling: 'last_token', source: 'copy, no license stated' },
];

const LABELS = 10;
const PROTOTYPES_PER_LABEL = 100;
const WARMUP_CALLS = 20;
const TIMED_CALLS = 300;
const TARGET_P95_MS = 100;
const CACHE_DIR = process.env.FLOWS_MODEL_CACHE ?? fileURLToPath(new URL('../../.cache/models', import.meta.url));
const RESULTS_FILE = new URL('./RESULTS.md', import.meta.url);

type Row = {
  candidate: Candidate;
  loadSec: number;
  dims: number;
  size: InputSize;
  tokens: number;
  embed: number[];
  match: number[];
  total: number[];
};

function load(candidate: Candidate) {
  return pipeline('feature-extraction', candidate.model, {
    revision: candidate.revision,
    dtype: candidate.dtype,
    device: 'cpu',
    cache_dir: CACHE_DIR,
    ...(candidate.externalData ? { use_external_data_format: true } : {}),
  });
}

// Prototype values don't change the timing, so random unit vectors stand in for labelled examples.
function randomUnitVectors(count: number, dims: number): Float32Array {
  const vectors = new Float32Array(count * dims);
  for (let row = 0; row < count; row++) {
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      const value = Math.random() * 2 - 1;
      vectors[row * dims + d] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    for (let d = 0; d < dims; d++) vectors[row * dims + d] /= norm;
  }
  return vectors;
}

// Best similarity per label; inputs are unit vectors, so the dot product is the cosine.
function bestScorePerLabel(query: Float32Array, prototypes: Float32Array, dims: number): Float32Array {
  const best = new Float32Array(LABELS).fill(-Infinity);
  for (let row = 0; row < LABELS * PROTOTYPES_PER_LABEL; row++) {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += query[d] * prototypes[row * dims + d];
    const label = Math.floor(row / PROTOTYPES_PER_LABEL);
    if (dot > best[label]) best[label] = dot;
  }
  return best;
}

async function measure(candidate: Candidate): Promise<Row[]> {
  // The first load downloads into the cache; the timed load reads from it.
  await (await load(candidate)).dispose();
  const loadStart = performance.now();
  const extractor = await load(candidate);
  const loadSec = (performance.now() - loadStart) / 1000;

  const embed = async (text: string): Promise<Float32Array> => {
    const output = await extractor(text, { pooling: candidate.pooling, normalize: true });
    if (!(output.data instanceof Float32Array)) throw new TypeError(`${candidate.model}: expected float32 embeddings`);
    return output.data;
  };

  const dims = (await embed('warm up')).length;
  const prototypes = randomUnitVectors(LABELS * PROTOTYPES_PER_LABEL, dims);
  const rows: Row[] = [];
  let sink = 0; // keeps the match work observable so it can't be optimised away

  for (const size of Object.keys(INPUTS) as InputSize[]) {
    const texts = INPUTS[size];
    for (let i = 0; i < WARMUP_CALLS; i++) sink += bestScorePerLabel(await embed(texts[i % texts.length]), prototypes, dims)[0];
    const row: Row = { candidate, loadSec, dims, size, tokens: 0, embed: [], match: [], total: [] };
    for (let i = 0; i < TIMED_CALLS; i++) {
      const start = performance.now();
      const vector = await embed(texts[i % texts.length]);
      const embedded = performance.now();
      sink += bestScorePerLabel(vector, prototypes, dims)[0];
      const end = performance.now();
      row.embed.push(embedded - start);
      row.match.push(end - embedded);
      row.total.push(end - start);
    }
    row.tokens = Math.round(texts.reduce((sum, text) => sum + extractor.tokenizer.encode(text).length, 0) / texts.length);
    rows.push(row);
    console.log(formatRow(row));
  }
  await extractor.dispose();
  if (Number.isNaN(sink)) throw new Error('match produced NaN');
  return rows;
}

const ms = (values: number[], p: number) => percentile(values, p).toFixed(1);

function formatRow(row: Row): string {
  const { candidate: c } = row;
  const p95 = percentile(row.total, 95);
  return `| ${c.model} | ${c.dtype} | ${c.source} | ${row.dims} | ${row.loadSec.toFixed(1)} | ${row.size} | ${row.tokens} | ${ms(row.embed, 50)} | ${ms(row.embed, 95)} | ${ms(row.match, 95)} | ${ms(row.total, 50)} | **${p95.toFixed(1)}** | ${ms(row.total, 99)} | ${ms(row.total, 100)} | ${p95 < TARGET_P95_MS ? 'yes' : 'no'} |`;
}

const packageVersion = (name: string): string =>
  JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;

const header = [
  '| Model | dtype | Source | Dims | Load (s) | Input | Tokens (mean) | Embed p50 | Embed p95 | Match p95 | Total p50 | Total p95 | Total p99 | Max | p95 < 100 ms |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
console.log(header.join('\n'));

const rows: string[] = [];
const failures: string[] = [];
for (const candidate of CANDIDATES) {
  try {
    rows.push(...(await measure(candidate)).map(formatRow));
  } catch (error) {
    // Reported in RESULTS.md and fails the run; the other candidates still get measured.
    const message = `${candidate.model} (${candidate.dtype}): ${error instanceof Error ? error.message : String(error)}`;
    failures.push(message);
    console.error(`FAILED ${message}`);
  }
}

const environment = [
  `- Date: ${new Date().toISOString().slice(0, 10)}`,
  `- CPU: ${os.cpus()[0]?.model ?? 'unknown'}, ${os.availableParallelism()} cores; RAM ${Math.round(os.totalmem() / 2 ** 30)} GB; ${os.type()} ${os.release()}`,
  `- Node ${process.version}; @huggingface/transformers ${packageVersion('@huggingface/transformers')}; onnxruntime-node ${packageVersion('onnxruntime-node')}; device cpu; ONNX Runtime session options left at their defaults`,
  `- Each input size: ${WARMUP_CALLS} warm-up calls, then ${TIMED_CALLS} timed calls, one text per call (batch size 1, like decide())`,
  `- Match: dot product against ${LABELS * PROTOTYPES_PER_LABEL} prototype vectors (${LABELS} labels x ${PROTOTYPES_PER_LABEL}), best score per label`,
  '- Times in milliseconds. Load = second load of the model, read from the local cache',
];

writeFileSync(
  RESULTS_FILE,
  [
    '# Latency spike results (Phase 0)',
    '',
    'Written by `npm run bench:latency`. The target is p95 < 100 ms for embed + match on CPU (PLAN.md Phase 0).',
    '',
    ...environment,
    '',
    ...header,
    ...rows,
    '',
    failures.length > 0 ? `## Failed\n\n${failures.map((f) => `- ${f}`).join('\n')}\n` : '',
  ].join('\n'),
);
console.log(`\nWrote ${fileURLToPath(RESULTS_FILE)}`);
if (failures.length > 0) process.exitCode = 1;
