import {
  ADDRESS_IDENTITY_NAMESPACE,
  addressIdentityId,
  addressIdentityIdsFrom,
  pickAddressIdentityId
} from './address-identity-id';

const A = '0x00000000000000000000000000000000000000aa';

describe('address-only identity ids', () => {
  it('derives the same id from an address in any case, a new one per n', () => {
    expect(addressIdentityId(A.toUpperCase().replace('0X', '0x'))).toBe(
      addressIdentityId(A)
    );
    const ids = [0, 1, 2].map((n) => addressIdentityId(A, n));
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(ADDRESS_IDENTITY_NAMESPACE).toBe(
      '7e587c0f-e470-430d-984a-9d9d5ccce0ef'
    );
  });

  it('picks the first candidate nothing holds', () => {
    const held = new Set([addressIdentityId(A), addressIdentityId(A, 1)]);
    expect(pickAddressIdentityId(A, (id) => held.has(id))).toBe(
      addressIdentityId(A, 2)
    );
    expect(pickAddressIdentityId(A, () => false)).toBe(addressIdentityId(A));
  });

  it('derives from switch-on, by the time given', () => {
    const saved = process.env.IDENTITY_SWITCH_ON_AT;
    process.env.IDENTITY_SWITCH_ON_AT = '2026-11-28T00:00:00Z';
    try {
      expect(addressIdentityIdsFrom(Date.parse('2026-11-27T23:59:59Z'))).toBe(
        false
      );
      expect(addressIdentityIdsFrom(Date.parse('2026-11-28T00:00:00Z'))).toBe(
        true
      );
    } finally {
      if (saved === undefined) delete process.env.IDENTITY_SWITCH_ON_AT;
      else process.env.IDENTITY_SWITCH_ON_AT = saved;
    }
  });
});
