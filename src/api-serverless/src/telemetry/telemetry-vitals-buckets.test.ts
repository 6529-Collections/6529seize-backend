import fc from 'fast-check';
import {
  vitalsBucket,
  vitalsBucketMidpoint,
  vitalsQuantile,
  vitalsUnitValue
} from '@/api/telemetry/telemetry-vitals-buckets';

describe('vitals buckets', () => {
  it('reads values back within one bucket width (about 9%)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 300_000, noNaN: true }), (value) => {
        const midpoint = vitalsBucketMidpoint(vitalsBucket(value));
        return Math.abs(midpoint - value) / value < 0.095;
      })
    );
  });

  it('puts sub-unit values in bucket 0 and scales CLS to thousandths', () => {
    expect(vitalsBucket(0)).toBe(0);
    expect(vitalsBucket(0.5)).toBe(0);
    expect(vitalsUnitValue('cls', 0.1)).toBe(100);
    expect(vitalsUnitValue('lcp', 2500)).toBe(2500);
  });

  it('reads quantiles back from bucket counts', () => {
    const samples = [100, 200, 300, 400, 2500, 2600, 2700, 9000];
    const counts = new Map<number, number>();
    for (const sample of samples) {
      const bucket = vitalsBucket(sample);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const buckets = Array.from(counts.entries()).map(([bucket, count]) => ({
      bucket,
      count
    }));
    const p75 = vitalsQuantile('lcp', buckets, 0.75)!;
    expect(Math.abs(p75 - 2600) / 2600).toBeLessThan(0.1);
    expect(vitalsQuantile('lcp', [], 0.75)).toBeNull();
    expect(
      vitalsQuantile('cls', [{ bucket: vitalsBucket(100), count: 3 }], 0.5)
    ).toBeCloseTo(0.1, 1);
  });
});
