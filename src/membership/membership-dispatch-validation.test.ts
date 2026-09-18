import fc from 'fast-check';
import {
  initialMembershipDispatchProgress,
  normalizeMembershipDispatchProgress,
  normalizeMembershipDispatchSignedCounter,
  validateMembershipDispatchOptions
} from './membership-dispatch-validation';
import { membershipDispatchTestOptions } from './membership-dispatch-test.helpers';

describe('membership dispatch strict cursor', () => {
  it('round trips exact signed BIGINT scheduling values without number conversion', () => {
    fc.assert(
      fc.property(
        fc.bigInt({
          min: BigInt('-9223372036854775808'),
          max: BigInt('9223372036854775807')
        }),
        (value) => {
          expect(normalizeMembershipDispatchSignedCounter(String(value))).toBe(
            String(value)
          );
        }
      )
    );
  });
  it.each([
    '-0',
    '+1',
    '01',
    '-01',
    '1.0',
    '1e3',
    '9223372036854775808',
    '-9223372036854775809',
    1,
    9007199254740992,
    null
  ])('rejects a noncanonical or lossy signed cursor: %s', (value) => {
    expect(() => normalizeMembershipDispatchSignedCounter(value)).toThrow();
  });
  it('keeps bounded malformed physical keys for later candidate diagnosis', () => {
    const progress = initialMembershipDispatchProgress();
    progress.due = {
      sweep: '9007199254740993',
      cutoff_millis: '3',
      after: null,
      through: {
        scope: 'éx',
        target_id: '',
        available_at_millis: '-9223372036854775808'
      }
    };
    expect(
      normalizeMembershipDispatchProgress(JSON.stringify(progress))
    ).toEqual(progress);
  });
  it('rejects partial bounds and unknown fields instead of resetting a sweep', () => {
    const initial = initialMembershipDispatchProgress();
    const key = { scope: 'PROFILE', target_id: 'a' };
    const bad = [
      { ...initial, other: {} },
      { ...initial, next_lane: 'RUNS' },
      { ...initial, due: { ...initial.due, cutoff_millis: '1' } },
      { ...initial, target_pk: { ...initial.target_pk, after: key } },
      {
        ...initial,
        due: {
          ...initial.due,
          cutoff_millis: '1',
          through: { ...key, available_at_millis: '2' }
        }
      },
      {
        ...initial,
        target_pk: { ...initial.target_pk, sweep: '9223372036854775808' }
      },
      {
        ...initial,
        target_pk: {
          ...initial.target_pk,
          through: { ...key, target_id: 'x'.repeat(201) }
        }
      },
      '{',
      ' '.repeat(8193)
    ];
    for (const value of bad)
      expect(() => normalizeMembershipDispatchProgress(value)).toThrow();
  });
  it('enforces invocation, per-lane and phase-reserve ceilings', () => {
    validateMembershipDispatchOptions(membershipDispatchTestOptions());
    validateMembershipDispatchOptions(
      membershipDispatchTestOptions({
        max_candidates: 240,
        max_per_lane: 120,
        prioritize_full: true
      })
    );
    for (const override of [
      { max_candidates: 241 },
      { max_per_lane: 121 },
      { reservation_millis: 120001 },
      { control_millis: 200, finalization_reserve_millis: 200 },
      { deadline_monotonic_millis: Number.NaN }
    ])
      expect(() =>
        validateMembershipDispatchOptions(
          membershipDispatchTestOptions(override)
        )
      ).toThrow();
  });
});
