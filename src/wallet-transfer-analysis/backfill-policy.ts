export interface BackfillMetric {
  timestamps: Date[];
  values: number[];
  complete: boolean;
}

export const BACKFILL_METRICS = {
  cpu: 'CPUUtilization',
  connections: 'DatabaseConnections',
  read: 'ReadLatency',
  write: 'WriteLatency',
  memory: 'FreeableMemory'
} as const;

export type BackfillMetricName = keyof typeof BACKFILL_METRICS;
export type BackfillLimits = Record<BackfillMetricName, number>;

/** Require three recent healthy samples; missing monitoring always pauses work. */
export function backfillLoadGate(
  metrics: Partial<Record<BackfillMetricName, BackfillMetric>>,
  limits: BackfillLimits,
  now: number
): { healthy: boolean; reasons: string[]; observed: Partial<BackfillLimits> } {
  const reasons: string[] = [];
  const observed: Partial<BackfillLimits> = {};
  for (const name of Object.keys(BACKFILL_METRICS) as BackfillMetricName[]) {
    const metric = metrics[name];
    const samples = (metric?.timestamps ?? [])
      .map((timestamp, index) => ({
        at: timestamp.getTime(),
        value: metric?.values[index]
      }))
      .filter(
        (sample) =>
          Number.isFinite(sample.value) &&
          sample.at <= now &&
          sample.at >= now - 5 * 60_000
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, 3);
    if (
      !metric?.complete ||
      samples.length < 3 ||
      samples[0].at < now - 3 * 60_000
    ) {
      reasons.push(`${name}: monitoring missing or stale`);
      continue;
    }
    const values = samples.map((sample) => sample.value!);
    observed[name] =
      name === 'memory' ? Math.min(...values) : Math.max(...values);
    const exceeded =
      name === 'memory'
        ? observed[name]! < limits[name]
        : observed[name]! > limits[name];
    if (exceeded) reasons.push(`${name}: load threshold exceeded`);
  }
  return { healthy: reasons.length === 0, reasons, observed };
}

export function backfillCooldown(
  elapsedMs: number,
  dutyPercent: number
): number {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    dutyPercent < 1 ||
    dutyPercent > 10
  ) {
    throw new Error('Invalid backfill pacing inputs');
  }
  return Math.max(2_000, Math.ceil(elapsedMs * (100 / dutyPercent - 1)));
}
