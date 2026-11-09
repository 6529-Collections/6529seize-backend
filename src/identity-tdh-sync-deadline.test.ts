import { resolveSyncDeadline } from '@/identity-tdh-sync';
import { Time } from '@/time';

const START = 1_000_000;
const minutes = (n: number) => Time.minutes(n).toMillis();
const seconds = (n: number) => Time.seconds(n).toMillis();

describe('identities sync deadline', () => {
  it('uses the invocation budget when it leaves at least the minimum slice', () => {
    expect(
      resolveSyncDeadline({
        now: START + minutes(1),
        startedAt: START,
        budgetDeadline: START + minutes(5),
        minimumSliceMs: seconds(150)
      })
    ).toEqual({ deadline: START + minutes(5), floorApplied: false });
  });

  it('gives a resume its minimum slice past a budget its work used up', () => {
    const now = START + minutes(4);
    expect(
      resolveSyncDeadline({
        now,
        startedAt: START,
        budgetDeadline: START + minutes(5),
        minimumSliceMs: seconds(150)
      })
    ).toEqual({ deadline: now + seconds(150), floorApplied: true });
    // Work that ran past the whole budget still leaves the resume a slice.
    expect(
      resolveSyncDeadline({
        now: START + minutes(8),
        startedAt: START,
        budgetDeadline: START + minutes(5),
        minimumSliceMs: seconds(150)
      }).deadline
    ).toBe(START + minutes(8) + seconds(150));
  });

  it('gives no shortened slice near the 12-minute stop: the spent budget stands, so the sync does not start', () => {
    // A whole slice fits: it ends exactly at the stop.
    expect(
      resolveSyncDeadline({
        now: START + minutes(9) + seconds(30),
        startedAt: START,
        budgetDeadline: START + minutes(5),
        minimumSliceMs: seconds(150)
      })
    ).toEqual({ deadline: START + minutes(12), floorApplied: true });
    // It does not: no floor, and the deadline has passed.
    expect(
      resolveSyncDeadline({
        now: START + minutes(11) + seconds(59),
        startedAt: START,
        budgetDeadline: START + minutes(5),
        minimumSliceMs: seconds(150)
      })
    ).toEqual({ deadline: START + minutes(5), floorApplied: false });
  });

  it('gives no floor without a minimum slice', () => {
    expect(
      resolveSyncDeadline({
        now: START + minutes(6),
        startedAt: START,
        budgetDeadline: START + minutes(5),
        minimumSliceMs: 0
      })
    ).toEqual({ deadline: START + minutes(5), floorApplied: false });
  });
});
