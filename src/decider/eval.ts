import { UNKNOWN, type Decider, type Decision } from './decider.ts';
import { testHalf, type Task } from './task.ts';

// PLAN.md Phase 7 eval harness: how one decision type does on its held-out half.
export type TaskReport = {
  task: string;
  heldOut: number;
  decided: number;
  right: number;
  coverage: number; // decided / held-out
  accuracy: number; // right / decided (1 when nothing was decided)
  labels: { label: string; precision: number; recall: number }[]; // precision over decided items, recall over all
  ece: number; // expected calibration error of the top probability, 5 bins, over every held-out item
  misses: { text: string; expected: string; got: string; prob: number }[];
};

const BINS = 5;

const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);

// |accuracy - confidence| in each bin of the top probability, weighted by the bin's share of items.
export function expectedCalibrationError(items: readonly { prob: number; right: boolean }[]): number {
  if (items.length === 0) return 0;
  let error = 0;
  for (let bin = 0; bin < BINS; bin++) {
    const inBin = items.filter((item) => Math.min(BINS - 1, Math.floor(item.prob * BINS)) === bin);
    if (inBin.length === 0) continue;
    const accuracy = inBin.filter((item) => item.right).length / inBin.length;
    const confidence = inBin.reduce((sum, item) => sum + item.prob, 0) / inBin.length;
    error += (inBin.length / items.length) * Math.abs(accuracy - confidence);
  }
  return error;
}

export async function evaluateTask(decider: Decider, task: Task): Promise<TaskReport> {
  const results: { item: Task['labelled'][number]; decision: Decision }[] = [];
  for (const item of testHalf(task)) results.push({ item, decision: await decider.decide(task.task, item.text, task.labels) });
  const decided = results.filter(({ decision }) => decision.label !== UNKNOWN);
  const right = decided.filter(({ item, decision }) => decision.label === item.label);
  // The label the probabilities favour, decided or not, for calibration.
  const top = (probs: Record<string, number>) => Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    task: task.task,
    heldOut: results.length,
    decided: decided.length,
    right: right.length,
    coverage: ratio(decided.length, results.length),
    accuracy: ratio(right.length, decided.length),
    labels: task.labels.map((label) => ({
      label,
      precision: ratio(right.filter(({ decision }) => decision.label === label).length, decided.filter(({ decision }) => decision.label === label).length),
      recall: ratio(right.filter(({ item }) => item.label === label).length, results.filter(({ item }) => item.label === label).length),
    })),
    ece: expectedCalibrationError(results.map(({ item, decision }) => ({ prob: decision.prob, right: top(decision.all_probs) === item.label }))),
    misses: results.filter(({ item, decision }) => decision.label !== item.label).map(({ item, decision }) => ({ text: item.text, expected: item.label, got: decision.label, prob: decision.prob })),
  };
}

export type Drift = { task: string; decided: number; overridden: number; rate: number | null; warn: boolean };

export const MIN_OVERRIDES = 10;

// PLAN.md Phase 7 drift monitor: of the inputs the current Decider (this version, since its last refit) decided, how
// many a person then labelled otherwise. Below MIN_OVERRIDES the rate says nothing yet (null).
export function drift(task: string, decisions: ReadonlyMap<string, string>, learned: Readonly<Record<string, readonly string[]>>, warnAt: number): Drift {
  let overridden = 0;
  for (const [label, texts] of Object.entries(learned)) {
    for (const text of texts) if (decisions.has(text) && decisions.get(text) !== label) overridden++;
  }
  const rate = overridden < MIN_OVERRIDES ? null : overridden / decisions.size;
  return { task, decided: decisions.size, overridden, rate, warn: rate !== null && rate > warnAt };
}
