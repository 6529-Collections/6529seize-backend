import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { IdentityEntity } from '@/entities/IIdentity';
import { ProfileClassification } from '@/entities/IProfile';
import { ChainIdentityReads } from './chain-identity-reads';
import { principalProfileId } from './identity-plan';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P = '0x' + 'ab'.repeat(32);
const Q = '0x' + 'cd'.repeat(32);
const ALICE = '00000000-0000-4000-8000-0000000a11ce';
const OLD = '00000000-0000-4000-8000-000000000001';

function chainIdentity(other: Partial<ChainIdentity> = {}): ChainIdentity {
  return {
    principalId: P,
    kind: 'person',
    status: 'active',
    createdHeight: 3,
    handle: 'alice',
    anchor: W(2),
    primary: W(1),
    primarySource: 'anchor',
    wallets: [W(2), W(1)],
    profile: {
      docCid: '0x01551220' + '00'.repeat(32),
      version: 1,
      updatedHeight: 4
    },
    rep: { total: '500', raters: 3 },
    nic: { total: '-20', raters: 1 },
    level: {
      level: 8,
      raw: '4734',
      rep: '500',
      tdh: '3000',
      tdhDay: 25
    },
    mergedInto: null,
    ...other
  };
}

function row(other: Partial<IdentityEntity> = {}): IdentityEntity {
  return {
    consolidation_key: `${W(1)}-${W(2)}`,
    profile_id: ALICE,
    primary_address: W(1),
    handle: 'Alice',
    normalised_handle: 'alice',
    tdh: 3000,
    rep: 1,
    cic: 1,
    level_raw: 1,
    pfp: 'old',
    banner1: null,
    banner2: null,
    classification: null,
    sub_classification: null,
    xtdh: 12.5,
    xtdh_rate: 0.5,
    basetdh_rate: 2,
    produced_xtdh: 4,
    granted_xtdh: 1,
    ...other
  };
}

/** The document is decoded from JSON, as a JSON upload would be. */
const DOC = Buffer.from(
  JSON.stringify({
    fields: {
      displayName: 'Alice',
      avatar: 'ipfs://pfp',
      banner1: '#111111',
      classification: 'ORGANIZATION',
      subClassification: 'Painter'
    }
  })
);

function setup({
  identities = new Map<string, ChainIdentity>([[P, chainIdentity()]]),
  mapping = new Map<string, string>([[P, ALICE]]),
  rows = [row()]
}: {
  identities?: Map<string, ChainIdentity>;
  mapping?: Map<string, string>;
  rows?: IdentityEntity[];
} = {}) {
  const byWallet = (w: string) =>
    Array.from(identities.values()).find((it) => it.wallets.includes(w)) ??
    null;
  const gateway = {
    getIdentityByWallet: jest.fn(async (w: string) => byWallet(w)),
    getIdentityByHandle: jest.fn(
      async (h: string) =>
        Array.from(identities.values()).find((it) => it.handle === h) ?? null
    ),
    getIdentityByPrincipal: jest.fn(
      async (p: string) => identities.get(p) ?? null
    ),
    getIdentityByLegacyProfileId: jest.fn(async (uuid: string) =>
      uuid === ALICE ? (identities.get(P) ?? null) : null
    ),
    getProfileDoc: jest.fn(async () => DOC),
    getHandle: jest.fn(async (h: string) => ({
      handle: h,
      valid: h !== 'x',
      available: h === 'free',
      status: 'free',
      principalId: null,
      since: null,
      reservedUntil: null
    }))
  };
  const mappingDb = {
    profileIdOfPrincipal: jest.fn(async (p: string) => mapping.get(p) ?? null),
    principalOfProfile: jest.fn(
      async (id: string) =>
        Array.from(mapping.entries()).find(([, v]) => v === id)?.[0] ?? null
    )
  };
  const rowsDb = {
    getIdentityByWallet: jest.fn(
      async (w: string) =>
        rows.find((it) => it.consolidation_key.split('-').includes(w)) ?? null
    ),
    getIdentityByProfileId: jest.fn(
      async (id: string) => rows.find((it) => it.profile_id === id) ?? null
    ),
    getIdentityByHandle: jest.fn(
      async (h: string) =>
        rows.find((it) => it.normalised_handle === h.toLowerCase()) ?? null
    )
  };
  return {
    reads: new ChainIdentityReads(
      gateway as never,
      mappingDb as never,
      rowsDb as never
    ),
    gateway
  };
}

describe('ChainIdentityReads', () => {
  it('reads an identity by wallet from the chain, shaped as a row', async () => {
    const { reads } = setup();
    expect(await reads.byWallet(W(2))).toEqual({
      consolidation_key: `${W(1)}-${W(2)}`,
      profile_id: ALICE,
      primary_address: W(1),
      handle: 'Alice',
      normalised_handle: 'alice',
      tdh: 3000,
      rep: 500,
      cic: -20,
      level_raw: 4734,
      pfp: 'ipfs://pfp',
      banner1: '#111111',
      banner2: null,
      classification: ProfileClassification.ORGANIZATION,
      sub_classification: 'Painter',
      xtdh: 12.5,
      xtdh_rate: 0.5,
      basetdh_rate: 2,
      produced_xtdh: 4,
      granted_xtdh: 1
    });
  });

  it('answers a wallet the chain holds no identity for from the index, if unmapped', async () => {
    const unimported = row({
      consolidation_key: W(9),
      profile_id: OLD,
      handle: `id-${W(9)}`
    });
    const { reads } = setup({ rows: [row(), unimported] });
    expect(await reads.byWallet(W(9))).toEqual(unimported);
    // A wallet that left a chain identity is answered as no identity.
    const { reads: after } = setup({
      identities: new Map([[P, chainIdentity({ wallets: [W(1)] })]])
    });
    expect(await after.byWallet(W(2))).toBeNull();
  });

  it('finds an identity without a chain handle by its placeholder', async () => {
    const { reads } = setup({
      identities: new Map([[P, chainIdentity({ handle: null })]]),
      rows: [row({ handle: `id-${W(1)}`, normalised_handle: `id-${W(1)}` })]
    });
    const found = await reads.byHandle(`id-${W(1)}`);
    expect(found?.profile_id).toBe(ALICE);
    expect(found?.handle).toBe(`id-${W(1)}`);
    expect(await reads.byHandle('nobody')).toBeNull();
  });

  it('reads by profile id through the mapping, the import, or the index', async () => {
    const mapped = setup();
    expect((await mapped.reads.byProfileId(ALICE))?.rep).toBe(500);
    const imported = setup({ mapping: new Map() });
    expect((await imported.reads.byProfileId(ALICE))?.profile_id).toBe(ALICE);
    expect(imported.gateway.getIdentityByLegacyProfileId).toHaveBeenCalledWith(
      ALICE
    );
    const old = row({ profile_id: OLD, consolidation_key: W(9) });
    const index = setup({ rows: [old] });
    expect(await index.reads.byProfileId(OLD)).toEqual(old);
  });

  it('treats a merged or closing identity as none', async () => {
    const { reads } = setup({
      identities: new Map([
        [P, chainIdentity({ status: 'merged', mergedInto: Q })]
      ])
    });
    expect(await reads.byProfileId(ALICE)).toBeNull();
  });

  it('maps an identity not mirrored yet by its anchor wallet, else by its id', async () => {
    const { reads } = setup({ mapping: new Map() });
    expect(await reads.profileIdOf(chainIdentity())).toBe(ALICE);
    const fresh = chainIdentity({
      principalId: Q,
      wallets: [W(7)],
      anchor: W(7)
    });
    expect(await reads.profileIdOf(fresh)).toBe(principalProfileId(Q));
    expect(
      await reads.profileIdOf({ ...fresh, legacyId: OLD.toUpperCase() })
    ).toBe(OLD);
  });

  it('answers handle availability from the chain', async () => {
    const { reads } = setup();
    expect(await reads.handleAvailability('free')).toEqual({
      available: true,
      message: 'Username is available.'
    });
    expect((await reads.handleAvailability('taken')).available).toBe(false);
    expect((await reads.handleAvailability('x')).message).toContain(
      'Invalid username'
    );
  });
});
