import { DeciderError } from '../shared/errors.ts';

export function softmax(scores: readonly number[], temperature: number): number[] {
  const scaled = scores.map((score) => score / temperature);
  const max = Math.max(...scaled); // subtracted so exp never overflows
  const exps = scaled.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

export type CalibrationItem = { scores: readonly number[]; label: number };

const logLoss = (items: readonly CalibrationItem[], temperature: number): number =>
  items.reduce((sum, item) => sum - Math.log(Math.max(softmax(item.scores, temperature)[item.label], 1e-12)), 0) / items.length;

// PLAN.md §7.2 temperature scaling: the T in [0.001, 1] that minimises log-loss of softmax(scores / T).
// Log-loss is convex in 1/T, so a golden-section search over log T finds the minimum.
export function fitTemperature(items: readonly CalibrationItem[]): number {
  if (items.length === 0) throw new DeciderError('cannot calibrate on an empty set');
  const ratio = (Math.sqrt(5) - 1) / 2;
  let low = Math.log(1e-3);
  let high = Math.log(1);
  for (let step = 0; step < 80; step++) {
    const left = high - ratio * (high - low);
    const right = low + ratio * (high - low);
    if (logLoss(items, Math.exp(left)) < logLoss(items, Math.exp(right))) high = right;
    else low = left;
  }
  return Math.exp((low + high) / 2);
}
