import {
  ChainIdentityView,
  consolidationKeyOf,
  CurrentIdentityState,
  IdentityRowState,
  planIdentity,
  principalProfileId,
  ProfileRowState
} from './identity-plan';
import { EMPTY_PROFILE_DOC_FIELDS } from './profile-doc';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const A = W(1);
const B = W(2);
const C = W(3);
const U = '00000000-0000-4000-8000-0000000a11ce';
const V = '00000000-0000-4000-8000-000000000005';
const P = '0x' + 'ab'.repeat(32);

function row(
  key: string,
  profileId: string | null,
  other: Partial<IdentityRowState> = {}
): IdentityRowState {
  return {
    consolidation_key: key,
    profile_id: profileId,
    primary_address: key.split('-')[0],
    handle: null,
    normalised_handle: null,
    tdh: 0,
    rep: 0,
    cic: 0,
    level_raw: 0,
    pfp: null,
    banner1: null,
    banner2: null,
    classification: null,
    sub_classification: null,
    xtdh: 0,
    produced_xtdh: 0,
    granted_xtdh: 0,
    xtdh_rate: 0,
    basetdh_rate: 0,
    ...other
  };
}

function profile(
  externalId: string,
  handle: string,
  other: Partial<ProfileRowState> = {}
): ProfileRowState {
  return {
    external_id: externalId,
    handle,
    normalised_handle: handle.toLowerCase(),
    primary_wallet: A,
    pfp_url: null,
    banner_1: null,
    banner_2: null,
    website: null,
    classification: null,
    sub_classification: null,
    ...other
  };
}

function chain(other: Partial<ChainIdentityView> = {}): ChainIdentityView {
  return {
    principalId: P,
    profileId: U,
    handle: 'Alice',
    wallets: [A, B],
    primary: A,
    doc: {
      ...EMPTY_PROFILE_DOC_FIELDS,
      pfp: 'ipfs://pfp',
      website: 'https://example.org',
      classification: 'PSEUDONYM'
    },
    rep: 30,
    cic: 4,
    levelRaw: 1234,
    ...other
  };
}

const AB = consolidationKeyOf([A, B]);

function state(
  other: Partial<CurrentIdentityState> = {}
): CurrentIdentityState {
  return {
    rows: [row(AB, U, { tdh: 1000, xtdh: 5, handle: 'Alice' })],
    walletsByKey: { [AB]: [A, B] },
    profile: profile(U, 'Alice'),
    handleHolder: null,
    placeholderTaken: false,
    ...other
  };
}

describe('planIdentity', () => {
  it('updates an imported identity in place at switch-on', () => {
    const plan = planIdentity(chain(), state());
    expect(plan.deleteKeys).toEqual([]);
    expect(plan.soloRows).toEqual([]);
    expect(plan.identity).toEqual(
      expect.objectContaining({
        consolidation_key: AB,
        profile_id: U,
        primary_address: A,
        handle: 'Alice',
        normalised_handle: 'alice',
        rep: 30,
        cic: 4,
        level_raw: 1234,
        tdh: 1000,
        xtdh: 5,
        pfp: 'ipfs://pfp',
        classification: 'PSEUDONYM'
      })
    );
    expect(plan.profile).toEqual(
      expect.objectContaining({
        insert: false,
        external_id: U,
        handle: 'Alice',
        website: 'https://example.org'
      })
    );
    expect(plan.pairs).toEqual([{ wallet1: A, wallet2: B }]);
    expect(plan.addressKeys).toEqual([
      { address: A, consolidation_key: AB },
      { address: B, consolidation_key: AB }
    ]);
    expect(plan.statements).toEqual([]);
    expect(plan.releaseHandle).toBeNull();
  });

  it('merges a joining wallet and its old row into the identity', () => {
    const plan = planIdentity(
      chain({ wallets: [C, A, B] }),
      state({
        rows: [
          row(AB, U, { tdh: 1000 }),
          row(C, V, { handle: `id-${C}`, tdh: 7 })
        ],
        walletsByKey: { [AB]: [A, B], [C]: [C] }
      })
    );
    const ABC = consolidationKeyOf([A, B, C]);
    expect(plan.deleteKeys).toEqual([AB, C].sort());
    expect(plan.identity.consolidation_key).toBe(ABC);
    expect(plan.identity.tdh).toBe(1000);
    expect(plan.soloRows).toEqual([]);
    expect(plan.pairs).toHaveLength(3);
    expect(plan.touchedWallets).toEqual([A, B, C]);
  });

  it('gives a removed wallet its own row without a profile', () => {
    const ABC = consolidationKeyOf([A, B, C]);
    const plan = planIdentity(
      chain(),
      state({
        rows: [row(ABC, U)],
        walletsByKey: { [ABC]: [A, B, C] }
      })
    );
    expect(plan.deleteKeys).toEqual([ABC]);
    expect(plan.soloRows).toEqual([
      expect.objectContaining({
        consolidation_key: C,
        profile_id: null,
        primary_address: C
      })
    ]);
    expect(plan.addressKeys).toContainEqual({
      address: C,
      consolidation_key: C
    });
    expect(plan.pairWallets).toEqual([A, B, C]);
    expect(plan.pairs).toEqual([{ wallet1: A, wallet2: B }]);
    expect(plan.touchedWallets).toEqual([A, B, C]);
  });

  it('takes a handle from the profile that held it', () => {
    const plan = planIdentity(
      chain({ handle: 'bob' }),
      state({ handleHolder: { external_id: V, releaseHandle: `id-${C}` } })
    );
    expect(plan.releaseHandle).toEqual({
      external_id: V,
      handle: `id-${C}`
    });
    expect(plan.profile.handle).toBe('bob');
  });

  it('makes a profile with a placeholder handle for a new identity', () => {
    const plan = planIdentity(
      chain({ handle: null, wallets: [C], primary: C, doc: null }),
      {
        rows: [],
        walletsByKey: {},
        profile: null,
        handleHolder: null,
        placeholderTaken: false
      }
    );
    expect(plan.profile).toEqual(
      expect.objectContaining({
        insert: true,
        handle: `id-${C}`,
        normalised_handle: `id-${C}`,
        primary_wallet: C,
        pfp_url: null,
        website: null
      })
    );
    expect(plan.identity.consolidation_key).toBe(C);
    expect(plan.identity.level_raw).toBe(1234);
    expect(plan.pairs).toEqual([]);
    expect(plan.statements).toEqual([]);
  });

  it('keeps a placeholder handle the profile already has', () => {
    const plan = planIdentity(
      chain({ handle: null }),
      state({ profile: profile(U, `id-${B}`) })
    );
    expect(plan.profile.handle).toBe(`id-${B}`);
  });

  it('keeps the profile columns when its document could not be read', () => {
    const plan = planIdentity(
      chain({ doc: undefined, levelRaw: null }),
      state({
        rows: [row(AB, U, { pfp: 'old-pfp', tdh: 100, xtdh: 2 })],
        profile: profile(U, 'Alice', { website: 'old-site' })
      })
    );
    expect(plan.identity.pfp).toBe('old-pfp');
    expect(plan.profile.website).toBe('old-site');
    expect(plan.statements).toBeNull();
    expect(plan.identity.level_raw).toBe(30 + 100 + 2);
  });
});

describe('principalProfileId', () => {
  it('derives the same UUID for the same principal', () => {
    const id = principalProfileId(P);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(principalProfileId(P.toUpperCase().replace('0X', '0x'))).toBe(id);
    expect(principalProfileId('0x' + 'cd'.repeat(32))).not.toBe(id);
  });

  it("keeps another identity's row on its remaining wallets", () => {
    const D = W(4);
    const CD = consolidationKeyOf([C, D]);
    const plan = planIdentity(
      chain({ wallets: [A, B, C] }),
      state({
        rows: [
          row(AB, U, { tdh: 1000 }),
          row(CD, V, { tdh: 70, xtdh: 3, primary_address: C, handle: 'quinn' })
        ],
        walletsByKey: { [AB]: [A, B], [CD]: [C, D] }
      })
    );
    expect(plan.deleteKeys).toEqual([AB, CD].sort());
    expect(plan.rekeyedRows).toEqual([
      expect.objectContaining({
        consolidation_key: D,
        profile_id: V,
        primary_address: D,
        tdh: 70,
        xtdh: 3,
        handle: 'quinn'
      })
    ]);
    expect(plan.soloRows).toEqual([]);
    expect(plan.addressKeys).toContainEqual({
      address: D,
      consolidation_key: D
    });
    expect(plan.pairs).toHaveLength(3);
  });

  it('keeps the case of a handle the owner wrote', () => {
    expect(
      planIdentity(chain({ handle: 'alice' }), state()).profile.handle
    ).toBe('Alice');
    expect(
      planIdentity(
        chain({
          handle: 'bob',
          doc: { ...EMPTY_PROFILE_DOC_FIELDS, displayName: 'BoB' }
        }),
        state()
      ).profile.handle
    ).toBe('BoB');
  });

  it('does not take a placeholder another profile holds', () => {
    const plan = planIdentity(
      chain({ handle: null, wallets: [C], primary: C }),
      {
        rows: [],
        walletsByKey: {},
        profile: null,
        handleHolder: null,
        placeholderTaken: true
      }
    );
    expect(plan.profile.handle).toBe(`id-${U}`);
  });
});
