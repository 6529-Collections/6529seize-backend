import {
  membershipInteger,
  membershipTruth,
  validateMembershipActiveInput
} from '@/membership/membership-evaluation-validation';
import { ActiveInputV1 } from '@/membership/membership-evaluator.types';
const active: ActiveInputV1 = {
  protocol_version: 1,
  seed_fingerprint: 'a'.repeat(64),
  group_id: 'canonical-group',
  group_version: '0',
  scalar_plan_fingerprint: 'b'.repeat(64),
  grant_metadata_fingerprint: null,
  valid_until_millis: null,
  stage: {
    kind: 'RATING',
    axis: 'REP',
    after: { category: 'café', other_profile_id: null },
    signed_sum: '-10',
    matching_count: '1'
  }
};
describe('membership evaluator continuation decoding', () => {
  it('retains signed accumulators and source text without applying target ID rules', () => {
    expect(validateMembershipActiveInput(active)).toEqual(active);
    expect(
      validateMembershipActiveInput({
        ...active,
        stage: {
          ...active.stage,
          after: { category: '', other_profile_id: null }
        }
      })
    ).toBeDefined();
  });
  it.each([
    { ...active, extra: true },
    { ...active, group_id: 'café' },
    { ...active, stage: { kind: 'FINISH', eligible: true } },
    { ...active, stage: { kind: 'PREPARE' } },
    { ...active, stage: { kind: 'SCALARS', sql: 'SELECT 1' } },
    {
      ...active,
      stage: {
        kind: 'NFT_ANY',
        contract_slot: 4,
        wallets: { after_wallet: null }
      }
    },
    { ...active, seed_fingerprint: 'a'.repeat(32769) }
  ])('rejects malformed or oversized state %#', (value) => {
    expect(() => validateMembershipActiveInput(value)).toThrow();
  });
  it('normalizes real driver scalar shapes without rounding unsafe BIGINTs', () => {
    expect(membershipInteger('0')).toBe(0);
    expect(membershipInteger(BigInt(24))).toBe(24);
    expect(() => membershipInteger('9007199254740993')).toThrow(
      'exact numeric domain'
    );
    expect(() => membershipInteger(null)).toThrow();
  });
  it.each([
    [0, false],
    ['0', false],
    [false, false],
    [1, true],
    ['1', true],
    [true, true],
    [null, false]
  ])('decodes SQL boolean %p explicitly', (value, expected) => {
    expect(membershipTruth(value)).toBe(expected);
  });
});
