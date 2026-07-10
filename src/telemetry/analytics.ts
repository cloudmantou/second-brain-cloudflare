/** Pure analytics helpers shared by the API and tests. */

export const TELEMETRY_HOUR_MS = 3_600_000;

export function hourBucket(timestamp: number): number {
  return Math.floor(timestamp / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS;
}

/** Nearest-rank percentile. Returns null when there are no samples. */
export function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q = Math.min(Math.max(quantile, 0), 1);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}
