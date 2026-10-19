// Nearest-rank percentile: the smallest sample with at least p% of all samples at or below it.
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RangeError('percentile of an empty sample');
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}
