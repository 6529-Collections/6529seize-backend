import { telemetryRetentionCutoffDay } from '@/api/telemetry/telemetry-retention';

describe('telemetryRetentionCutoffDay', () => {
  it('keeps 25 months of daily rows', () => {
    expect(telemetryRetentionCutoffDay(new Date('2026-11-06T12:00:00Z'))).toBe(
      '2024-10-06'
    );
    expect(telemetryRetentionCutoffDay(new Date('2027-01-31T00:00:00Z'))).toBe(
      '2024-12-31'
    );
  });

  it('clamps to the end of a shorter month instead of rolling over', () => {
    expect(telemetryRetentionCutoffDay(new Date('2026-03-31T00:00:00Z'))).toBe(
      '2024-02-29'
    );
    expect(telemetryRetentionCutoffDay(new Date('2027-03-31T00:00:00Z'))).toBe(
      '2025-02-28'
    );
    expect(telemetryRetentionCutoffDay(new Date('2026-12-31T00:00:00Z'))).toBe(
      '2024-11-30'
    );
  });
});
