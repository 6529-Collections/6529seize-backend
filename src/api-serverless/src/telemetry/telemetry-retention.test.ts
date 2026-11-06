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
});
