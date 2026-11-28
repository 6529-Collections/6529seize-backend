import { isMemesMintStatsEligible } from '@/memes-mint-stats/memes-mint-stats';
import { Time } from '@/time';

describe('isMemesMintStatsEligible', () => {
  const mintDate = new Date('2026-01-02T00:00:00Z');

  it('is false until 17:00 UTC on the day after the mint date', () => {
    expect(
      isMemesMintStatsEligible(
        mintDate,
        Time.fromDate(new Date('2026-01-03T16:59:59.999Z'))
      )
    ).toBe(false);
  });

  it('is true from 17:00 UTC on the day after the mint date', () => {
    expect(
      isMemesMintStatsEligible(
        mintDate,
        Time.fromDate(new Date('2026-01-03T17:00:00Z'))
      )
    ).toBe(true);
  });

  it('takes the mint date in UTC, whatever its time of day', () => {
    expect(
      isMemesMintStatsEligible(
        new Date('2026-01-02T23:30:00Z'),
        Time.fromDate(new Date('2026-01-03T17:00:00Z'))
      )
    ).toBe(true);
  });
});
