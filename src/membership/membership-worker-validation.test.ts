import fc from 'fast-check';
import {
  normalizeMembershipWorkerCursor,
  membershipAddCounter,
  membershipProfileSourceKeys
} from './membership-worker-validation';

const cursor = {
  protocol_version: 2,
  kind: 'PROFILE',
  phase: 'SCAN',
  after_id: null,
  through_id: 'z-group',
  traversal_collation: 'utf8mb4_unicode_ci',
  identity_consolidation_key: 'canonical-key',
  active_input: null
};

describe('membership worker persisted contracts', () => {
  it('round trips a strict cursor including reader retirement metadata', () => {
    const input = {
      ...cursor,
      gc: { retired_at_millis: '9007199254740993', after_group_id: 'group' }
    };
    expect(normalizeMembershipWorkerCursor(JSON.stringify(input))).toEqual(
      input
    );
  });
  it.each([
    { ...cursor, protocol_version: 1 },
    { ...cursor, unexpected: true },
    { ...cursor, active_input: undefined },
    { ...cursor, identity_consolidation_key: 'x'.repeat(201) },
    { ...cursor, traversal_collation: 'utf8;DROP' },
    { ...cursor, gc: { retired_at_millis: 123, after_group_id: null } }
  ])('rejects incompatible or ambiguous cursor metadata', (input) => {
    expect(() => normalizeMembershipWorkerCursor(input)).toThrow();
  });
  it('rejects pending input attached to ready or done phases', () => {
    const active = {
      protocol_version: 1,
      seed_fingerprint: 'a'.repeat(64),
      group_id: 'group',
      group_version: '1',
      scalar_plan_fingerprint: 'b'.repeat(64),
      grant_metadata_fingerprint: null,
      valid_until_millis: null,
      stage: { kind: 'SCALARS' }
    };
    expect(() =>
      normalizeMembershipWorkerCursor({
        ...cursor,
        phase: 'READY_TO_FINISH',
        active_input: active
      })
    ).toThrow();
  });
  it('keeps counter increments exact above the safe-number boundary', () => {
    fc.assert(
      fc.property(
        fc.bigInt({
          min: BigInt('9007199254740992'),
          max: BigInt('9223372036854775806')
        }),
        (n) => {
          expect(membershipAddCounter(String(n), 1)).toBe(
            String(n + BigInt(1))
          );
        }
      )
    );
    expect(() => membershipAddCounter('9223372036854775807', 1)).toThrow();
  });
  it('captures the exact conservative thirteen keys in canonical order', () => {
    const keys = membershipProfileSourceKeys('profile');
    expect(keys).toHaveLength(13);
    expect(keys.filter((key) => key.scope === 'GLOBAL')).toHaveLength(7);
    expect(keys.filter((key) => key.dimension === 'GROUP_CATALOG')).toEqual([
      { scope: 'GLOBAL', target_id: '*', dimension: 'GROUP_CATALOG' }
    ]);
  });
});
