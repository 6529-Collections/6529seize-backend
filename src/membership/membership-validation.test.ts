import fc from 'fast-check';
import {
  assertMembershipBoundedInteger,
  assertMembershipId,
  MAX_MEMBERSHIP_COUNTER,
  MembershipSourceKey,
  normalizeCounter,
  normalizeRefreshTarget,
  normalizeSourceKey,
  normalizeSourceVector,
  orderedSourceKeys
} from '@/membership/membership-validation';

const globalKey: MembershipSourceKey = {
  scope: 'GLOBAL',
  target_id: '*',
  dimension: 'TDH_XTDH'
};
const profileKey: MembershipSourceKey = {
  scope: 'PROFILE',
  target_id: 'profile-A',
  dimension: 'RATINGS'
};

describe('membership counter normalization', () => {
  it('preserves every nonnegative signed BIGINT exactly', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: BigInt(0), max: BigInt(MAX_MEMBERSHIP_COUNTER) }),
        (value) => {
          expect(normalizeCounter(value)).toBe(value.toString());
          expect(normalizeCounter(value.toString())).toBe(value.toString());
          expect(
            JSON.parse(JSON.stringify({ version: normalizeCounter(value) }))
          ).toEqual({ version: value.toString() });
        }
      )
    );
  });

  it('accepts safe driver numbers, including zero', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (value) => {
          expect(normalizeCounter(value)).toBe(value.toString());
        }
      )
    );
  });

  it.each([
    undefined,
    null,
    true,
    false,
    {},
    [],
    '',
    ' ',
    '01',
    '00',
    '-0',
    '-1',
    '+1',
    '1.0',
    '1e3',
    '0x10',
    '1\n',
    ' 1',
    '1 ',
    '-9007199254740993',
    '9223372036854775808',
    '999999999999999999999999999999999',
    BigInt(-1),
    BigInt('9223372036854775808'),
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1
  ])('rejects malformed or imprecise counter %p', (value) => {
    expect(() => normalizeCounter(value)).toThrow('membership counter');
  });
});

describe('membership source keys', () => {
  it('preserves exact case-sensitive canonical IDs and returns a copy', () => {
    expect(normalizeSourceKey(profileKey)).toEqual(profileKey);
    expect(normalizeSourceKey(profileKey)).not.toBe(profileKey);
    expect(normalizeSourceKey(globalKey)).toEqual(globalKey);
  });

  it.each([
    null,
    [],
    'GLOBAL',
    {},
    { ...globalKey, scope: 'global' },
    { ...globalKey, target_id: 'profile-A' },
    { ...globalKey, dimension: 'UNKNOWN' },
    { ...profileKey, target_id: '*' },
    { ...profileKey, target_id: ' profile-A' },
    { ...profileKey, target_id: 'profile-A ' },
    { ...profileKey, target_id: 'a/b' },
    { ...profileKey, target_id: 'é' },
    { ...profileKey, target_id: 'x'.repeat(101) },
    { ...profileKey, dimension: 'GROUP_CATALOG' }
  ])('rejects malformed source key %p', (value) => {
    expect(() => normalizeSourceKey(value)).toThrow('membership');
  });

  it('orders fields using binary ID order, locking GLOBAL keys first', () => {
    const keys: MembershipSourceKey[] = [
      { ...profileKey, target_id: 'a-' },
      { ...profileKey, target_id: 'a' },
      { ...profileKey, target_id: 'Z' },
      globalKey,
      { ...globalKey, dimension: 'IDENTITY' }
    ];
    expect(orderedSourceKeys(keys)).toEqual([
      { ...globalKey, dimension: 'IDENTITY' },
      globalKey,
      { ...profileKey, target_id: 'Z' },
      { ...profileKey, target_id: 'a' },
      { ...profileKey, target_id: 'a-' }
    ]);
    expect(keys[0].target_id).toBe('a-');
  });

  it('rejects duplicate and oversized key sets before a lock operation', () => {
    expect(() => orderedSourceKeys([profileKey, profileKey])).toThrow(
      'duplicate'
    );
    expect(() =>
      orderedSourceKeys(
        Array.from({ length: 65 }, (_, i) => ({
          ...profileKey,
          target_id: `p-${i}`
        }))
      )
    ).toThrow('limit');
    expect(orderedSourceKeys([])).toEqual([]);
    expect(() =>
      orderedSourceKeys(null as unknown as MembershipSourceKey[])
    ).toThrow('membership');
  });

  it('is deterministic for shuffled distinct keys', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 999 }), { maxLength: 64 }),
        (ids) => {
          const keys = ids.map((id) => ({
            ...profileKey,
            target_id: `p-${id}`
          }));
          expect(orderedSourceKeys([...keys].reverse())).toEqual(
            orderedSourceKeys(keys)
          );
        }
      )
    );
  });
});

describe('membership source vectors', () => {
  it('normalizes exact coverage to source lock order without rounding', () => {
    const input = [
      { ...profileKey, version: BigInt('9007199254740993') },
      { ...globalKey, version: 2 }
    ];
    expect(normalizeSourceVector(input, [profileKey, globalKey])).toEqual([
      { ...globalKey, version: '2' },
      { ...profileKey, version: '9007199254740993' }
    ]);
  });

  it('rejects missing, duplicate, substituted, unknown and invalid entries', () => {
    const globalVersion = { ...globalKey, version: '1' };
    const profileVersion = { ...profileKey, version: '2' };
    for (const input of [
      null,
      '{}',
      {},
      [],
      [globalVersion],
      [globalVersion, globalVersion],
      [globalVersion, { ...profileVersion, dimension: 'IDENTITY' }],
      [globalVersion, { ...profileVersion, version: null }],
      [
        globalVersion,
        { ...profileVersion, version: Number.MAX_SAFE_INTEGER + 1 }
      ],
      [globalVersion, { ...profileVersion, scope: 'UNKNOWN' }]
    ]) {
      expect(() =>
        normalizeSourceVector(input, [globalKey, profileKey])
      ).toThrow('membership');
    }
    expect(() =>
      normalizeSourceVector(
        [globalVersion, globalVersion],
        [globalKey, globalKey]
      )
    ).toThrow('duplicate');
    expect(normalizeSourceVector([], [])).toEqual([]);
  });
});

describe('membership refresh targets and assertions', () => {
  it('allows exact FULL target and canonical bounded PROFILE/GROUP targets', () => {
    for (const target of [
      { scope: 'FULL', target_id: '*' },
      { scope: 'PROFILE', target_id: 'p'.repeat(100) },
      { scope: 'GROUP', target_id: 'g'.repeat(200) }
    ]) {
      expect(normalizeRefreshTarget(target)).toEqual(target);
    }
  });

  it.each([
    null,
    [],
    {},
    { scope: 'GLOBAL', target_id: '*' },
    { scope: 'FULL', target_id: 'p' },
    { scope: 'PROFILE', target_id: '*' },
    { scope: 'PROFILE', target_id: 'p'.repeat(101) },
    { scope: 'GROUP', target_id: 'g'.repeat(201) },
    { scope: 'GROUP', target_id: 'g ' }
  ])('rejects malformed refresh target %p', (value) => {
    expect(() => normalizeRefreshTarget(value)).toThrow('membership');
  });

  it('validates named IDs and integer budgets at their boundaries', () => {
    expect(() => assertMembershipId('valid-ID_2', 'job ID', 20)).not.toThrow();
    expect(() => assertMembershipId('', 'job ID', 20)).toThrow('job ID');
    for (const value of [0, 20]) {
      expect(() =>
        assertMembershipBoundedInteger(value, 'limit', 0, 20)
      ).not.toThrow();
    }
    for (const value of [-1, 21, '1', 1.1, undefined]) {
      expect(() =>
        assertMembershipBoundedInteger(value, 'limit', 0, 20)
      ).toThrow('limit');
    }
  });
});
