import { join } from 'node:path';
import { z } from 'zod';
import type { Threshold } from '../config/project.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { cached, cachedVectors } from '../embeddings/vector-cache.ts';
import { DeciderError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { eventBase } from '../trace/event.ts';
import type { TraceSink } from '../trace/sink.ts';
import { fitTemperature, softmax } from './calibration.ts';
import { calibrationHalf, type Task } from './task.ts';

export const UNKNOWN = 'unknown';

export type Decision = { label: string; prob: number; all_probs: Record<string, number>; version: string };

export interface Decider {
  decide(taskType: string, input: string, allowedLabels: readonly string[]): Promise<Decision>;
}

export type DeciderDeps = {
  tasks: readonly Task[];
  provider: EmbeddingProvider;
  trace: TraceSink;
  cacheDir: string; // vectors and calibration live here, keyed by model and task data
  threshold: (taskType: string) => Threshold;
};

type Prepared = {
  labels: readonly string[];
  rules: { regex: RegExp; label: string }[];
  prototypes: Float32Array[];
  prototypeLabels: number[];
  temperature: number;
  version: string;
};

// Best cosine similarity per label (vectors are unit length, so the dot product is the cosine).
function bestScores(vector: Float32Array, prepared: Pick<Prepared, 'prototypes' | 'prototypeLabels'>, labelIndexes: readonly number[]): number[] {
  const best = labelIndexes.map(() => -Infinity);
  prepared.prototypes.forEach((prototype, p) => {
    const slot = labelIndexes.indexOf(prepared.prototypeLabels[p]);
    if (slot === -1) return;
    let dot = 0;
    for (let d = 0; d < vector.length; d++) dot += vector[d] * prototype[d];
    if (dot > best[slot]) best[slot] = dot;
  });
  return best;
}

// PLAN.md §7, v1: plain rules first, then a prototype classifier on embeddings, temperature-calibrated,
// with a reject option that answers `unknown` instead of guessing.
export class DeciderV1 implements Decider {
  readonly #deps: DeciderDeps;
  readonly #prepared = new Map<string, Promise<Prepared>>();

  constructor(deps: DeciderDeps) {
    this.#deps = deps;
  }

  async decide(taskType: string, input: string, allowedLabels: readonly string[]): Promise<Decision> {
    const startedAt = performance.now();
    const task = this.#deps.tasks.find((candidate) => candidate.task === taskType);
    if (!task) throw new DeciderError(`unknown decision type "${taskType}"`);
    if (new Set(allowedLabels).size < 2 || allowedLabels.some((label) => !task.labels.includes(label))) {
      throw new DeciderError(`allowed labels for ${taskType} must be two or more of: ${task.labels.join(', ')} (got: ${allowedLabels.join(', ')})`);
    }
    const threshold = this.#deps.threshold(taskType);
    const prepared = await this.#prepare(task);
    const rule = prepared.rules.find((candidate) => allowedLabels.includes(candidate.label) && candidate.regex.test(input));
    const decision: Decision = rule
      ? { label: rule.label, prob: 1, all_probs: { [rule.label]: 1 }, version: prepared.version }
      : await this.#classify(prepared, input, allowedLabels, threshold);
    this.#deps.trace.record({
      ...eventBase(startedAt),
      kind: 'decision',
      decision_type: taskType,
      input,
      inputs_ref: sha256(input),
      allowed_labels: [...allowedLabels],
      label: decision.label,
      source: rule ? 'rule' : 'classifier',
      probs: decision.all_probs,
      threshold,
      model_version: decision.version,
    });
    return decision;
  }

  // The version decisions of this type carry now: it changes when the model or the task's data does (a refit).
  async version(taskType: string): Promise<string> {
    const task = this.#deps.tasks.find((candidate) => candidate.task === taskType);
    if (!task) throw new DeciderError(`unknown decision type "${taskType}"`);
    return (await this.#prepare(task)).version;
  }

  async #classify(prepared: Prepared, input: string, allowedLabels: readonly string[], threshold: Threshold): Promise<Decision> {
    const [vector] = await this.#deps.provider.embed([input]);
    const probs = softmax(bestScores(vector, prepared, allowedLabels.map((label) => prepared.labels.indexOf(label))), prepared.temperature);
    const order = probs.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const [top, second] = [probs[order[0]], probs[order[1]]];
    const sure = top >= threshold.min_prob && top - second >= threshold.min_margin;
    return {
      label: sure ? allowedLabels[order[0]] : UNKNOWN,
      prob: top,
      all_probs: Object.fromEntries(allowedLabels.map((label, i) => [label, probs[i]])),
      version: prepared.version,
    };
  }

  #prepare(task: Task): Promise<Prepared> {
    let prepared = this.#prepared.get(task.task);
    if (!prepared) {
      prepared = this.#build(task);
      this.#prepared.set(task.task, prepared);
      prepared.catch(() => this.#prepared.delete(task.task)); // retry on the next call instead of failing forever
    }
    return prepared;
  }

  async #build(task: Task): Promise<Prepared> {
    const { provider, cacheDir } = this.#deps;
    const labels = task.labels;
    const prototypeLabels = labels.flatMap((label, i) => task.examples[label].map(() => i));
    const prototypes = await cachedVectors(join(cacheDir, `${task.task}.examples.json`), labels.flatMap((label) => task.examples[label]), provider);
    const dataHash = sha256(JSON.stringify(task));
    // Calibration is keyed by model and data too, so swapping the model refits it (PLAN.md §6).
    const temperature = await cached(join(cacheDir, `${task.task}.calibration.json`), sha256(`${provider.version}|${dataHash}`), z.number().positive(), async () => {
      const items = calibrationHalf(task);
      const vectors = await provider.embed(items.map((item) => item.text));
      const all = labels.map((_, i) => i);
      return fitTemperature(items.map((item, i) => ({ scores: bestScores(vectors[i], { prototypes, prototypeLabels }, all), label: labels.indexOf(item.label) })));
    });
    return {
      labels,
      rules: task.rules.map((rule) => ({ regex: new RegExp(rule.pattern, rule.flags), label: rule.label })),
      prototypes,
      prototypeLabels,
      temperature,
      version: `decider-v1|${provider.version}|task:${dataHash.slice(0, 12)}|T=${temperature.toPrecision(4)}`,
    };
  }
}
