import { randomUUID } from 'node:crypto';
import {
  initialMembershipGcProgress,
  normalizeMembershipGcProgress
} from './membership-gc.types';

describe('membership GC durable cursor validation', () => {
  it('round trips the three independent terminal lanes', () => {
    const value = initialMembershipGcProgress();
    expect(normalizeMembershipGcProgress(JSON.stringify(value))).toEqual(value);
  });
  it('rejects duplicate lanes, slots, or run IDs', () => {
    const value = initialMembershipGcProgress();
    value.lanes[1].status = 'COMPLETED';
    expect(() => normalizeMembershipGcProgress(value)).toThrow();
    const entry = {
      slot: 0,
      run_id: randomUUID(),
      kind: 'DELETE' as const,
      eligible_at_millis: '0',
      claim_token: null,
      claim_expires_at_millis: null
    };
    expect(() =>
      normalizeMembershipGcProgress({
        ...initialMembershipGcProgress(),
        pending: [entry, entry]
      })
    ).toThrow();
  });
  it('compares raw BIGINT frontiers numerically, including beyond safe numbers', () => {
    const value = initialMembershipGcProgress();
    value.lanes[0] = {
      ...value.lanes[0],
      after: { id: randomUUID(), updated_at_millis: '9007199254740993' },
      through: { id: randomUUID(), updated_at_millis: '9007199254740992' },
      cutoff_millis: '9007199254740992'
    };
    expect(() => normalizeMembershipGcProgress(value)).toThrow();
  });
  it('allows a bounded raw malformed ID frontier so corrupt candidates cannot pin discovery', () => {
    const value = initialMembershipGcProgress();
    value.lanes[0] = {
      ...value.lanes[0],
      after: { id: 'corrupt', updated_at_millis: '2' },
      through: { id: 'z', updated_at_millis: '2' },
      cutoff_millis: '2'
    };
    expect(normalizeMembershipGcProgress(value)).toEqual(value);
  });
  it('rejects unbounded, unknown or incomplete scheduling claims', () => {
    const entry = {
      slot: 0,
      run_id: randomUUID(),
      kind: 'DELETE',
      eligible_at_millis: '0',
      claim_token: randomUUID(),
      claim_expires_at_millis: null
    };
    expect(() =>
      normalizeMembershipGcProgress({
        ...initialMembershipGcProgress(),
        pending: [entry]
      })
    ).toThrow();
    expect(() =>
      normalizeMembershipGcProgress({
        ...initialMembershipGcProgress(),
        other_lane: 'arbitrary'
      })
    ).toThrow();
  });
});
