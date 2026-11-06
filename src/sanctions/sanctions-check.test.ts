import {
  createSanctionsIndex,
  delegationCarriesRights,
  effectiveList,
  isSanctioned,
  listingInForce,
  profileSanctionStatus,
  sanctionListings
} from '@/sanctions/sanctions-check';
import type {
  SanctionsCorrectionsV1,
  SanctionsListV1
} from '@/sanctions/sanctions-list.types';
import { readSanctionsVector } from '@/sanctions/sanctions-spec-files';

interface CheckVectors {
  list: SanctionsListV1;
  is_sanctioned: Array<{ address: string; as_of: string; expected: boolean }>;
  profile_status: Array<{
    wallets: string[];
    as_of: string;
    expected: { blocked: boolean; matched: unknown[] };
  }>;
  delegation: Array<{
    from: string[];
    to: string[];
    as_of: string;
    expected: boolean;
  }>;
  corrections: Array<{
    corrections: SanctionsCorrectionsV1;
    checks: Array<{ address: string; as_of: string; expected: boolean }>;
    expected_totals: SanctionsListV1['totals'];
  }>;
}

const vectors = readSanctionsVector<CheckVectors>('check.json');
const index = createSanctionsIndex(vectors.list);

describe('isSanctioned', () => {
  it.each(vectors.is_sanctioned)(
    '$address on $as_of is $expected',
    ({ address, as_of, expected }) => {
      expect(isSanctioned(address, index, as_of)).toBe(expected);
    }
  );

  it.each(['2026-02-30', '2026-11-6', '', '20261106'])(
    'rejects the malformed date %p',
    (asOf) => {
      expect(() =>
        isSanctioned(vectors.list.addresses[0].address, index, asOf)
      ).toThrow(/YYYY-MM-DD/);
    }
  );
});

describe('profileSanctionStatus', () => {
  it.each(vectors.profile_status)(
    'profile %# on $as_of',
    ({ wallets, as_of, expected }) => {
      expect(profileSanctionStatus(wallets, index, as_of)).toEqual(expected);
    }
  );
});

describe('delegationCarriesRights', () => {
  it.each(vectors.delegation)(
    'delegation %# on $as_of is $expected',
    ({ from, to, as_of, expected }) => {
      expect(delegationCarriesRights(from, to, index, as_of)).toBe(expected);
    }
  );
});

describe('effectiveList', () => {
  it.each(vectors.corrections)('applies corrections %#', (vector) => {
    const corrected = effectiveList(vectors.list, vector.corrections);
    expect(corrected.totals).toEqual(vector.expected_totals);
    const correctedIndex = createSanctionsIndex(corrected);
    for (const check of vector.checks) {
      expect(isSanctioned(check.address, correctedIndex, check.as_of)).toBe(
        check.expected
      );
    }
  });

  it('leaves the original list unchanged', () => {
    const before = JSON.stringify(vectors.list);
    effectiveList(vectors.list, vectors.corrections[0].corrections);
    expect(JSON.stringify(vectors.list)).toBe(before);
  });
});

describe('sanctionListings and listingInForce', () => {
  it('returns lapsed listings for provenance but does not enforce them', () => {
    const address = vectors.list.addresses[2].address;
    const listings = sanctionListings(
      address.toUpperCase().replace('0X', '0x'),
      index
    );
    expect(listings).toHaveLength(2);
    expect(
      listings.map((listing) => listingInForce(listing, '2026-11-06'))
    ).toEqual([true, false]);
  });

  it('does not treat object prototype keys as addresses', () => {
    expect(sanctionListings('constructor', index)).toEqual([]);
  });
});

describe('createSanctionsIndex', () => {
  it('refuses a list with a non-normalized address', () => {
    const list = {
      ...vectors.list,
      addresses: [{ address: '0xABC', listings: [] }]
    };
    expect(() => createSanctionsIndex(list)).toThrow(/non-normalized/);
  });

  it('refuses an unknown schema', () => {
    const list = {
      ...vectors.list,
      schema: 'other'
    } as unknown as SanctionsListV1;
    expect(() => createSanctionsIndex(list)).toThrow(/schema/);
  });
});
