import { TelemetryVitalMetric } from '@/api/telemetry/telemetry.schema';

/**
 * Log-scale histogram buckets: 8 buckets per doubling (about 9% wide).
 * Bucket 0 holds values below 1 unit. Bucket b >= 1 holds
 * [2^((b-1)/8), 2^(b/8)). Time metrics are in milliseconds; CLS is stored in
 * thousandths so the same buckets fit it.
 */
export const VITALS_BUCKETS_PER_DOUBLING = 8;
export const VITALS_MAX_BUCKET = 160;

export function vitalsUnitValue(
  metric: TelemetryVitalMetric,
  value: number
): number {
  return metric === 'cls' ? value * 1000 : value;
}

export function vitalsBucket(unitValue: number): number {
  if (!(unitValue >= 1)) {
    return 0;
  }
  const bucket =
    1 + Math.floor(Math.log2(unitValue) * VITALS_BUCKETS_PER_DOUBLING);
  return Math.min(VITALS_MAX_BUCKET, bucket);
}

/** Geometric midpoint of a bucket, in the metric's stored unit. */
export function vitalsBucketMidpoint(bucket: number): number {
  if (bucket <= 0) {
    return 0;
  }
  return 2 ** ((bucket - 0.5) / VITALS_BUCKETS_PER_DOUBLING);
}

/**
 * Reads a quantile (for example 0.75) back from bucket counts. Returns the
 * value in the metric's natural unit (ms, or unitless CLS), or null when
 * there are no samples.
 */
export function vitalsQuantile(
  metric: TelemetryVitalMetric,
  buckets: ReadonlyArray<{ readonly bucket: number; readonly count: number }>,
  quantile: number
): number | null {
  const sorted = [...buckets]
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.bucket - b.bucket);
  const total = sorted.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) {
    return null;
  }
  const target = Math.max(1, Math.ceil(total * quantile));
  let seen = 0;
  for (const entry of sorted) {
    seen += entry.count;
    if (seen >= target) {
      const unitValue = vitalsBucketMidpoint(entry.bucket);
      return metric === 'cls' ? unitValue / 1000 : unitValue;
    }
  }
  return null;
}
