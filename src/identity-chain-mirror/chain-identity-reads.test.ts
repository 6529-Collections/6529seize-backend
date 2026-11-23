import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { IdentityEntity } from '@/entities/IIdentity';
import { ProfileClassification } from '@/entities/IProfile';
import { ChainIdentityReads } from './chain-identity-reads';
import { FirstBinding } from './identity-chain-mirror.db';
import { principalProfileId } from './identity-plan';
import { ProfileIds } from './profile-ids';

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
    // Imported: the gateway finds it by its legacy id too.
    legacyId: ALICE,
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

/** What the mirror's choice of a profile id reads (see ProfileIds). */
interface Choice {
  /** Placeholder profiles no principal holds, by wallet. */
  placeholders?: Map<string, string>;
  /** The mirror's own first bindings, by wallet. */
  firstBindings?: Map<string, FirstBinding>;
  /** Whether those are exact, and how far the bindings have read. */
  bindings?: { exact: boolean; nextHeight: number | null };
  /** Legacy ids by principal, as the import's entries give them. */
  imported?: Map<string, string>;
  /** Each wallet's history, as the gateway gives it. */
  history?: (wallet: string) => unknown;
  /** The chain the gateway serves, and the one the mirror's tables are of. */
  network?: string | null;
  mirrorChain?: string | null;
  /** The mirror has listed the placeholder profiles (default yes). */
  placeholdersListed?: boolean;
  /** The import, as the gateway's membership gives it. */
  importCompleted?: boolean;
  importStart?: number;
  importDone?: number;
}

function setup({
  identities = new Map<string, ChainIdentity>([[P, chainIdentity()]]),
  mapping = new Map<string, string>([[P, ALICE]]),
  rows = [row()],
  choice = {}
}: {
  identities?: Map<string, ChainIdentity>;
  mapping?: Map<string, string>;
  rows?: IdentityEntity[];
  choice?: Choice;
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
    getMembership: jest.fn(async () => ({
      import: {
        completed: choice.importCompleted ?? true,
        startHeight: choice.importStart ?? 50,
        doneHeight: choice.importDone ?? 60
      }
    })),
    getHead: jest.fn(async () => ({
      network: choice.network === undefined ? 'chain' : choice.network
    })),
    getMembershipWallet: jest.fn(async (wallet: string) => {
      const owner = byWallet(wallet);
      return {
        wallet,
        principalId: owner?.principalId ?? null,
        firstBoundHeight: owner?.createdHeight ?? null
      };
    }),
    getMembershipWalletHistory: jest.fn(async (wallet: string) =>
      choice.history ? choice.history(wallet) : null
    ),
    getImportedIdentity: jest.fn(async (p: string) =>
      choice.imported?.has(p) ? { legacyId: choice.imported.get(p) } : null
    ),
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
  // The mirror's tables as the choice reads them; a write throws.
  const readOnly = () => {
    throw new Error('a read wrote to the mirror');
  };
  const mirrorDb = {
    profileIdOfPrincipal: mappingDb.profileIdOfPrincipal,
    unmappedPlaceholderProfile: jest.fn(
      async (w: string) => choice.placeholders?.get(w) ?? null
    ),
    firstBindingOf: jest.fn(async (w: string) => ({
      first: choice.firstBindings?.get(w) ?? null,
      exact: choice.bindings?.exact ?? false,
      nextHeight: choice.bindings?.nextHeight ?? null
    })),
    executeNativeQueriesInTransaction: jest.fn(readOnly),
    insertMapping: jest.fn(readOnly),
    founderWaitSince: jest.fn(readOnly),
    founderWaitDone: jest.fn(readOnly),
    founderDecisionOf: jest.fn(async () => null),
    founderDecided: jest.fn(readOnly),
    getState: jest.fn(async () => ({
      chain_id: choice.mirrorChain === undefined ? 'chain' : choice.mirrorChain,
      placeholders_at: (choice.placeholdersListed ?? true) ? 1 : null
    }))
  };
  /**
   * What the mirror's run stores for the identity in the same state: its
   * profileIdOf, with the import's heights the run reads, over a copy of
   * the tables it may write ('wait' when it tries again later).
   */
  const mirrorStores = async (identity: ChainIdentity) => {
    const stored = new Map(mapping);
    const ids = new ProfileIds(
      gateway as never,
      {
        ...mirrorDb,
        profileIdOfPrincipal: async (p: string) => stored.get(p) ?? null,
        executeNativeQueriesInTransaction: async (
          fn: (c: unknown) => unknown
        ) => await fn({}),
        insertMapping: async (p: string, id: string) => {
          stored.set(p, id);
        },
        founderWaitSince: async (_: string, now: number) => now,
        founderWaitDone: async () => undefined,
        founderDecided: async () => undefined
      } as never,
      () => 1_000
    );
    ids.setImportHeights(choice.importStart ?? 50, choice.importDone ?? 60);
    try {
      return await ids.profileIdOf(identity);
    } catch (error) {
      if ((error as { retryLater?: boolean }).retryLater) return 'wait';
      throw error;
    }
  };
  return {
    reads: new ChainIdentityReads(
      gateway as never,
      mappingDb as never,
      rowsDb as never,
      mirrorDb as never
    ),
    gateway,
    mirrorDb,
    mirrorStores
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

  it('counts no xTDH in a level the chain does not give', async () => {
    const { reads } = setup({
      identities: new Map([[P, chainIdentity({ level: null as never })]])
    });
    // REP 500 from the chain plus TDH 3000 from the index; xTDH 12.5 is left out.
    expect((await reads.byWallet(W(2)))?.level_raw).toBe(3500);
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

  it('answers an imported identity not mirrored yet with its legacy id', async () => {
    const { reads } = setup({
      mapping: new Map(),
      choice: { imported: new Map([[Q, ALICE]]) }
    });
    // Given by the gateway.
    expect(
      await reads.profileIdOf(chainIdentity({ legacyId: OLD.toUpperCase() }))
    ).toBe(OLD);
    // Asked of the import when the gateway leaves it out.
    expect(
      await reads.profileIdOf(
        chainIdentity({ principalId: Q, legacyId: undefined })
      )
    ).toBe(ALICE);
  });

  it("gives an identity made on the chain its derived id, never its anchor wallet's other profile", async () => {
    // W(1), its founding wallet and anchor, is in Alice's index row.
    const made = chainIdentity({
      principalId: Q,
      legacyId: null,
      createdHeight: 80,
      founder: W(1),
      anchor: W(1),
      primary: W(1),
      wallets: [W(1)]
    });
    const { reads, mirrorDb } = setup({
      identities: new Map([[Q, made]]),
      mapping: new Map()
    });
    expect(await reads.profileIdOf(made)).toBe(principalProfileId(Q));
    expect((await reads.byWallet(W(1)))?.profile_id).toBe(
      principalProfileId(Q)
    );
    expect(mirrorDb.insertMapping).not.toHaveBeenCalled();
  });

  it("answers an identity made on the chain with its founding wallet's placeholder, or as none until the mirror can choose", async () => {
    const made = chainIdentity({
      principalId: Q,
      legacyId: null,
      handle: null,
      createdHeight: 80,
      founder: W(7),
      anchor: W(7),
      primary: W(7),
      wallets: [W(7)]
    });
    const identities = new Map([[Q, made]]);
    // The wallet's own row in the index, under another profile id.
    const rows = [
      row({
        consolidation_key: W(7),
        profile_id: 'p-anchor',
        handle: `id-${W(7)}`,
        normalised_handle: `id-${W(7)}`
      })
    ];
    const placeholders = new Map([[W(7), 'p-7']]);
    // The mirror's own bindings say W(7) was first bound to Q, at its
    // creation: the placeholder.
    const decided = setup({
      identities,
      mapping: new Map(),
      rows,
      choice: {
        placeholders,
        firstBindings: new Map([
          [W(7), { wallet: W(7), principal_id: Q, height: 80 }]
        ]),
        bindings: { exact: true, nextHeight: 100 }
      }
    });
    expect((await decided.reads.byWallet(W(7)))?.profile_id).toBe('p-7');
    // No binding of its own, and a history that starts after the import's
    // start, so it can't say: a founder wait. None, and no wait started.
    const waiting = setup({
      identities,
      mapping: new Map(),
      rows,
      choice: {
        placeholders,
        history: (wallet) => ({
          wallet,
          changes: [{ height: 80, principalId: Q }],
          ranges: [[70, 1000]],
          readHeight: 100
        })
      }
    });
    expect(await waiting.reads.byWallet(W(7))).toBeNull();
    expect(waiting.gateway.getMembershipWalletHistory).toHaveBeenCalledWith(
      W(7),
      { noBindingsBefore: 50 }
    );
    expect(waiting.mirrorDb.founderWaitSince).not.toHaveBeenCalled();
    // The mirror's bindings not at the creation yet: none as well.
    const behind = setup({
      identities,
      mapping: new Map(),
      rows,
      choice: { placeholders, bindings: { exact: true, nextHeight: 70 } }
    });
    expect(await behind.reads.byWallet(W(7))).toBeNull();
    // Once mapped, the mapping.
    const mapped = setup({
      identities,
      mapping: new Map([[Q, 'p-7']]),
      rows
    });
    expect((await mapped.reads.byWallet(W(7)))?.profile_id).toBe('p-7');
  });

  describe('agrees with the id the mirror stores', () => {
    const OTHER = '0x' + 'ee'.repeat(32);
    /** An identity made on the chain at 80 by W(7), whose placeholder is p-7. */
    const made = (other: Partial<ChainIdentity> = {}) =>
      chainIdentity({
        principalId: Q,
        legacyId: null,
        handle: null,
        createdHeight: 80,
        founder: W(7),
        anchor: W(7),
        primary: W(7),
        wallets: [W(7)],
        ...other
      });
    const placeholders = new Map([[W(7), 'p-7']]);
    /** W(7)'s history as the gateway gives it, held from `from`. */
    const historyOf =
      (changes: { height: number; principalId: string | null }[], from = 50) =>
      (wallet: string) => ({
        wallet,
        changes,
        ranges: [[from, 1000]],
        readHeight: 100
      });

    it.each<[string, ChainIdentity, Choice, 'same' | 'none', string | null]>([
      [
        'imported, its legacy id given',
        made({ legacyId: OLD }),
        {},
        'same',
        OLD
      ],
      [
        'imported, its legacy id asked of the import',
        made({ createdHeight: 55 }),
        { imported: new Map([[Q, ALICE]]) },
        'same',
        ALICE
      ],
      [
        'made on the chain, no placeholder: derived',
        made(),
        {},
        'same',
        principalProfileId(Q)
      ],
      [
        "the gateway's history says first: the placeholder",
        made(),
        { placeholders, history: historyOf([{ height: 80, principalId: Q }]) },
        'same',
        'p-7'
      ],
      [
        "the gateway's history says not first, with a placeholder: derived",
        made(),
        {
          placeholders,
          history: historyOf([
            { height: 65, principalId: OTHER },
            { height: 70, principalId: null },
            { height: 80, principalId: Q }
          ])
        },
        'same',
        principalProfileId(Q)
      ],
      [
        "the mirror's own bindings say first: the placeholder",
        made(),
        {
          placeholders,
          firstBindings: new Map([
            [W(7), { wallet: W(7), principal_id: Q, height: 80 }]
          ]),
          bindings: { exact: true, nextHeight: 100 }
        },
        'same',
        'p-7'
      ],
      [
        "the history can't say: a founder wait",
        made(),
        {
          placeholders,
          history: historyOf([{ height: 80, principalId: Q }], 70)
        },
        'none',
        null
      ],
      [
        "the mirror's bindings behind the creation",
        made(),
        { placeholders, bindings: { exact: true, nextHeight: 70 } },
        'none',
        null
      ],
      [
        'no founder from the gateway (the anchor decides, in time)',
        made({ founder: undefined }),
        {
          placeholders,
          firstBindings: new Map([
            [W(7), { wallet: W(7), principal_id: Q, height: 80 }]
          ]),
          bindings: { exact: true, nextHeight: 100 }
        },
        'none',
        null
      ],
      [
        'the placeholders not listed yet',
        made(),
        { placeholdersListed: false },
        'none',
        null
      ],
      [
        'the import not complete',
        made({ legacyId: OLD }),
        { importCompleted: false },
        'none',
        null
      ],
      [
        "the mirror's tables of another chain",
        made({ legacyId: OLD }),
        { network: 'relaunched' },
        'none',
        null
      ]
    ])('%s', async (_, identity, choice, expected, id) => {
      const { reads, mirrorStores } = setup({
        identities: new Map([[Q, identity]]),
        mapping: new Map(),
        choice
      });
      const read = await reads.profileIdOf(identity);
      const stored = await mirrorStores(identity);
      expect(read).toBe(id);
      if (expected === 'same') expect(read).toBe(stored);
    });

    it('takes the import as complete as soon as it is', async () => {
      const choice: Choice = { importCompleted: false };
      const { reads, mirrorStores } = setup({
        identities: new Map([[Q, made({ legacyId: OLD })]]),
        mapping: new Map(),
        choice
      });
      expect(await reads.profileIdOf(made({ legacyId: OLD }))).toBeNull();
      choice.importCompleted = true;
      expect(await reads.profileIdOf(made({ legacyId: OLD }))).toBe(
        await mirrorStores(made({ legacyId: OLD }))
      );
    });

    it("takes a relaunched chain's import heights at once", async () => {
      // Made at 100, after the old chain's import (done at 60): derived.
      const identity = made({ createdHeight: 100 });
      const choice: Choice = {
        network: 'old',
        mirrorChain: 'old',
        imported: new Map([[Q, ALICE]])
      };
      const { reads, mirrorStores } = setup({
        identities: new Map([[Q, identity]]),
        mapping: new Map(),
        choice
      });
      expect(await reads.profileIdOf(identity)).toBe(principalProfileId(Q));
      expect(await mirrorStores(identity)).toBe(principalProfileId(Q));
      // Relaunched: the gateway serves the new chain before the mirror has
      // seen it; its tables are the old chain's.
      choice.network = 'new';
      expect(await reads.profileIdOf(identity)).toBeNull();
      // The mirror on the new chain, whose import ended at 200: imported.
      choice.mirrorChain = 'new';
      choice.importStart = 150;
      choice.importDone = 200;
      expect(await reads.profileIdOf(identity)).toBe(ALICE);
      expect(await mirrorStores(identity)).toBe(ALICE);
    });
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
