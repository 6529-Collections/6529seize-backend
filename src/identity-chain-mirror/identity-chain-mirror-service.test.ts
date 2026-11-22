import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  ChainDelegation,
  ChainFeedPage,
  ChainIdentity,
  ChainRating
} from '@/chain-gateway/chain-gateway.types';
import {
  DelegationRowWrite,
  IdentityChainMirrorDb,
  MirrorState,
  RatingEventContext,
  RatingRowWrite
} from './identity-chain-mirror.db';
import { MembershipChange } from './membership-change';
import {
  feedEffects,
  IdentityChainMirror,
  pickWalletProfile,
  toDelegationRow
} from './identity-chain-mirror.service';
import {
  CHAIN_BLOCK_BASE,
  CurrentIdentityState,
  IdentityPlan,
  IdentityRowState,
  NEVER_EXPIRES,
  principalProfileId,
  ProfileRowState
} from './identity-plan';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const PID = (n: number) =>
  `0x${'ab'.repeat(28)}${n.toString(16).padStart(8, '0')}`;
const A = W(1);
const B = W(2);
const C = W(3);
const ALICE_PROFILE = '00000000-0000-4000-8000-0000000a11ce';

function chainIdentity(
  principal: string,
  wallets: string[],
  other: Partial<ChainIdentity> = {}
): ChainIdentity {
  return {
    principalId: principal,
    kind: 'person',
    status: 'active',
    createdHeight: 3,
    handle: null,
    anchor: wallets[0],
    primary: wallets[0],
    primarySource: 'anchor',
    wallets,
    profile: null,
    rep: { total: '0', raters: 0 },
    nic: { total: '0', raters: 0 },
    xtdh: '0',
    level: null,
    mergedInto: null,
    ...other
  };
}

/** An in-memory 6529.io identity database, as the mirror sees it. */
class FakeDb {
  state: MirrorState | null = null;
  mapping = new Map<string, { profile: string; origin: string }>();
  rows = new Map<string, IdentityRowState>();
  addressKeys = new Map<string, string>();
  profiles = new Map<string, ProfileRowState>();
  ratings = new Map<string, RatingRowWrite[]>();
  delegations = new Map<string, DelegationRowWrite[]>();
  pairs: { wallet1: string; wallet2: string }[] = [];
  ratingReads: { target: string; events: RatingEventContext }[] = [];
  keyWidth: number | null = null;

  async consolidationKeyWidth() {
    return this.keyWidth;
  }

  async executeNativeQueriesInTransaction<T>(fn: (c: unknown) => Promise<T>) {
    return fn({});
  }
  async getState() {
    return this.state;
  }
  async saveState(state: MirrorState) {
    this.state = state;
  }
  async profileIdOfPrincipal(p: string) {
    return this.mapping.get(p)?.profile ?? null;
  }
  async principalOfProfile(profile: string) {
    for (const [p, m] of Array.from(this.mapping.entries())) {
      if (m.profile === profile) return p;
    }
    return null;
  }
  async profileExists(profile: string) {
    return this.profiles.has(profile);
  }
  async unmappedProfilesOfWallets(wallets: string[]) {
    const mapped = new Set(
      Array.from(this.mapping.values()).map((it) => it.profile)
    );
    return wallets.flatMap((address) => {
      const row = this.rows.get(this.addressKeys.get(address) ?? '');
      const profile = row?.profile_id
        ? this.profiles.get(row.profile_id)
        : null;
      return profile && !mapped.has(profile.external_id)
        ? [{ profile_id: profile.external_id, handle: profile.handle, address }]
        : [];
    });
  }
  async insertMapping(p: string, profile: string, origin: string) {
    this.mapping.set(p, { profile, origin });
  }
  async readIdentityState(
    wallets: string[],
    profileId: string,
    handle: string | null,
    primary: string
  ): Promise<CurrentIdentityState> {
    const keys = new Set(
      wallets.map((w) => this.addressKeys.get(w)).filter((it) => !!it)
    );
    const rows = Array.from(this.rows.values()).filter(
      (it) => it.profile_id === profileId || keys.has(it.consolidation_key)
    );
    const walletsByKey: Record<string, string[]> = {};
    for (const [address, key] of Array.from(this.addressKeys.entries())) {
      if (rows.some((it) => it.consolidation_key === key)) {
        (walletsByKey[key] ??= []).push(address);
      }
    }
    const profile = this.profiles.get(profileId) ?? null;
    const holderOf = (normalised: string) =>
      Array.from(this.profiles.values()).find(
        (it) =>
          it.normalised_handle === normalised && it.external_id !== profileId
      );
    const holder = handle ? holderOf(handle.toLowerCase()) : undefined;
    return {
      rows,
      walletsByKey,
      profile,
      handleHolder: holder
        ? {
            external_id: holder.external_id,
            releaseHandle: `id-${holder.primary_wallet}`
          }
        : null,
      placeholderTaken: !!holderOf(`id-${primary}`)
    };
  }
  async applyIdentityPlan(plan: IdentityPlan) {
    if (plan.releaseHandle) {
      const p = this.profiles.get(plan.releaseHandle.external_id)!;
      this.profiles.set(p.external_id, {
        ...p,
        handle: plan.releaseHandle.handle,
        normalised_handle: plan.releaseHandle.handle.toLowerCase()
      });
    }
    for (const key of plan.deleteKeys) {
      this.rows.delete(key);
      for (const [a, k] of Array.from(this.addressKeys.entries())) {
        if (k === key) this.addressKeys.delete(a);
      }
    }
    for (const row of [plan.identity, ...plan.soloRows]) {
      this.rows.set(row.consolidation_key, row);
    }
    for (const it of plan.addressKeys) {
      this.addressKeys.set(it.address, it.consolidation_key);
    }
    const { insert: _insert, ...profile } = plan.profile;
    this.profiles.set(profile.external_id, profile);
    this.pairs = this.pairs.filter(
      (it) =>
        !plan.pairWallets.includes(it.wallet1) &&
        !plan.pairWallets.includes(it.wallet2)
    );
    this.pairs.push(...plan.pairs);
  }
  async replaceAllPairs(pairs: { wallet1: string; wallet2: string }[]) {
    this.pairs = [...pairs];
  }
  async replaceTargetRatings(
    target: string,
    rows: RatingRowWrite[],
    _now: number,
    events: RatingEventContext
  ) {
    this.ratings.set(target, rows);
    this.ratingReads.push({ target, events });
    return { inserted: rows.length, updated: 0, deleted: 0 };
  }
  async replaceWalletDelegations(wallet: string, rows: DelegationRowWrite[]) {
    this.delegations.set(wallet, rows);
    return { written: rows.length, deleted: 0 };
  }
  async walletsWithDelegations() {
    return Array.from(this.delegations.keys());
  }
  async principalsOfWallets(wallets: string[]) {
    return wallets.flatMap((w) => {
      const profile = this.rows.get(this.addressKeys.get(w) ?? '')?.profile_id;
      return Array.from(this.mapping.entries())
        .filter(([, m]) => m.profile === profile)
        .map(([p]) => p);
    });
  }
}

function delegation(
  holder: string,
  scope: 'wallet' | 'identity',
  other: Partial<ChainDelegation> = {}
): ChainDelegation {
  return {
    scope,
    holder,
    collection: W(0x8888),
    delegate: W(9),
    useCase: 2,
    allTokens: true,
    tokenId: '0',
    expiry: '18446744073709551615',
    expired: false,
    source: 'set',
    setHeight: 40,
    ethBlock: null,
    logIndex: null,
    setBy: null,
    ...other
  };
}

/** A gateway over a little chain the test edits. */
function world() {
  const alice = chainIdentity(PID(1), [A, B], {
    handle: 'alice',
    rep: { total: '5', raters: 1 },
    level: {
      level: 6,
      raw: '1005',
      rep: '5',
      tdh: '1000',
      xtdh: '0',
      tdhDay: 25
    }
  });
  const bob = chainIdentity(PID(2), [C], { handle: 'bob' });
  const chain = {
    identities: new Map<string, ChainIdentity>([
      [alice.principalId, alice],
      [bob.principalId, bob]
    ]),
    ratings: new Map<string, ChainRating[]>([
      [
        alice.principalId,
        [
          {
            rater: bob.principalId,
            target: alice.principalId,
            matter: 'rep',
            category: { id: '0x01', name: 'Kind' },
            value: '5',
            updatedHeight: 30,
            viaGrant: null
          }
        ]
      ]
    ]),
    delegations: [delegation(alice.principalId, 'identity')],
    feed: [] as ChainFeedPage[],
    importCompleted: true,
    finalized: 100
  };
  const gateway = {
    getHead: jest.fn(async () => ({
      headHeight: chain.finalized + 2,
      finalizedHeight: chain.finalized,
      finalizedTime: 0,
      pinnable: null
    })),
    getMembership: jest.fn(async () => ({
      import: { completed: chain.importCompleted }
    })),
    listIdentities: jest.fn(async (opts: { after?: string | null }) => {
      const all = Array.from(chain.identities.values()).sort((a, b) =>
        a.principalId < b.principalId ? -1 : 1
      );
      const start = opts.after
        ? all.findIndex((it) => it.principalId === opts.after) + 1
        : 0;
      const items = all.slice(start, start + 1);
      const more = start + 1 < all.length;
      return {
        items,
        next: more ? items[0].principalId : null,
        read: {} as never
      };
    }),
    getIdentityByPrincipal: jest.fn(
      async (p: string) => chain.identities.get(p) ?? null
    ),
    getIdentitiesByWallets: jest.fn(async (wallets: string[]) =>
      Object.fromEntries(
        wallets.map((w) => [
          w,
          Array.from(chain.identities.values()).find((it) =>
            it.wallets.includes(w)
          ) ?? null
        ])
      )
    ),
    getProfileDoc: jest.fn(async () => null),
    getIdentityByLegacyProfileId: jest.fn(async (uuid: string) =>
      uuid === ALICE_PROFILE ? chain.identities.get(alice.principalId)! : null
    ),
    getRatings: jest.fn(async (q: { target: string }) => ({
      items: chain.ratings.get(q.target) ?? [],
      next: null,
      read: {} as never
    })),
    getDelegations: jest.fn(
      async (q: { byUseCase?: number; holder?: string }) => ({
        items: chain.delegations.filter((it) =>
          q.byUseCase !== undefined
            ? it.useCase === q.byUseCase
            : it.holder === q.holder
        ),
        next: null,
        read: {} as never
      })
    ),
    getDelegationsOfWallet: jest.fn(async (wallet: string) => {
      const identity = Array.from(chain.identities.values()).find((it) =>
        it.wallets.includes(wallet)
      );
      return [
        {
          scope: 'wallet' as const,
          holder: wallet,
          records: chain.delegations.filter((it) => it.holder === wallet),
          more: false
        },
        ...(identity
          ? [
              {
                scope: 'identity' as const,
                holder: identity.principalId,
                records: chain.delegations.filter(
                  (it) => it.holder === identity.principalId
                ),
                more: false
              }
            ]
          : [])
      ];
    }),
    getChanges: jest.fn(async (from: number) => {
      const page = chain.feed.shift();
      if (page) return page;
      return { from, through: from - 1, blocks: [], next: from };
    })
  };
  const db = new FakeDb();
  let now = 1_000;
  const changes: { change: MembershipChange; connection: unknown }[] = [];
  const mirror = new IdentityChainMirror(
    gateway as never,
    db as unknown as IdentityChainMirrorDb,
    () => now,
    [
      async (change, ctx) => {
        changes.push({ change, connection: ctx.connection });
      }
    ]
  );
  return {
    chain,
    gateway,
    db,
    mirror,
    changes,
    alice,
    bob,
    tick: (ms: number) => {
      now += ms;
    }
  };
}

describe('IdentityChainMirror', () => {
  it('waits for the import to complete', async () => {
    const { chain, mirror, db } = world();
    chain.importCompleted = false;
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.skipped).toBe('import_not_complete');
    expect(db.state).toBeNull();
  });

  it('syncs everything first, then follows the feed from that height', async () => {
    const { mirror, db, alice, bob } = world();
    // Alice's wallet already has its imported 6529.io profile.
    db.profiles.set(ALICE_PROFILE, {
      external_id: ALICE_PROFILE,
      handle: 'alice',
      normalised_handle: 'alice',
      primary_wallet: A,
      pfp_url: null,
      banner_1: null,
      banner_2: null,
      website: null,
      classification: null,
      sub_classification: null
    });
    db.rows.set(`${A}-${B}`, {
      consolidation_key: `${A}-${B}`,
      profile_id: ALICE_PROFILE,
      primary_address: A,
      handle: 'alice',
      normalised_handle: 'alice',
      tdh: 1000,
      rep: 5,
      cic: 0,
      level_raw: 1005,
      pfp: null,
      banner1: null,
      banner2: null,
      classification: null,
      sub_classification: null,
      xtdh: 0,
      produced_xtdh: 0,
      granted_xtdh: 0,
      xtdh_rate: 0,
      basetdh_rate: 0
    });
    db.addressKeys.set(A, `${A}-${B}`);
    db.addressKeys.set(B, `${A}-${B}`);

    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.mode).toBe('full_sync');
    expect(db.state).toEqual(
      expect.objectContaining({
        next_height: 101,
        sync_phase: null,
        last_full_sync_at: 1_000
      })
    );
    // Alice keeps her imported profile id; Bob gets one from his principal.
    expect(db.mapping.get(alice.principalId)).toEqual({
      profile: ALICE_PROFILE,
      origin: 'LEGACY'
    });
    const bobProfile = principalProfileId(bob.principalId);
    expect(db.mapping.get(bob.principalId)?.profile).toBe(bobProfile);
    expect(db.profiles.get(bobProfile)?.handle).toBe('bob');
    expect(db.rows.get(`${A}-${B}`)).toEqual(
      expect.objectContaining({ level_raw: 1005, tdh: 1000, rep: 5 })
    );
    expect(db.ratings.get(ALICE_PROFILE)).toEqual([
      {
        rater_profile_id: bobProfile,
        matter: 'REP',
        matter_category: 'Kind',
        rating: 5,
        rater_principal: bob.principalId,
        height: 30
      }
    ]);
    // Found by a full pass at the height it started from.
    expect(
      db.ratingReads.find((it) => it.target === ALICE_PROFILE)?.events
    ).toEqual({
      targetPrincipal: alice.principalId,
      height: 100,
      source: 'FULL_SYNC'
    });
    // The identity's delegation covers each of its wallets.
    expect(db.delegations.get(A)).toEqual([
      expect.objectContaining({
        from_address: A,
        to_address: W(9),
        use_case: 2,
        block: CHAIN_BLOCK_BASE + 40,
        expiry: NEVER_EXPIRES
      })
    ]);
    expect(db.delegations.get(B)).toHaveLength(1);
    expect(db.pairs).toEqual([{ wallet1: A, wallet2: B }]);
  });

  it('applies a join from the feed, moving the wallet into the identity', async () => {
    const { mirror, db, chain, alice, bob, changes } = world();
    await mirror.run({ budgetMs: 60_000 });
    changes.length = 0;
    // Bob's wallet C leaves Bob and joins Alice.
    chain.identities.set(alice.principalId, { ...alice, wallets: [A, B, C] });
    chain.identities.set(bob.principalId, { ...bob, wallets: [] });
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [
        {
          height: 104,
          slot: 0,
          root: '0x',
          time: 0,
          records: [
            {
              family: '0x0102',
              name: 'AddressBinding',
              key: '0x',
              value: null,
              keyFields: { wallet: C },
              valueFields: { principal: alice.principalId }
            }
          ]
        }
      ]
    });
    // Bob, left with no wallet, isn't written (a principal with no wallet).
    chain.identities.delete(bob.principalId);
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.mode).toBe('feed');
    expect(db.state?.next_height).toBe(106);
    const key = [A, B, C].join('-');
    expect(db.rows.get(key)?.profile_id).toBe(
      db.mapping.get(alice.principalId)?.profile
    );
    expect(db.addressKeys.get(C)).toBe(key);
    expect(db.pairs).toHaveLength(3);
    expect(db.delegations.get(C)).toHaveLength(1);
    // The membership handlers hear of it in the mirror's transaction, with
    // every wallet of the rows before and after.
    expect(changes).toHaveLength(1);
    expect(changes[0].connection).toBeDefined();
    expect(changes[0].change).toEqual({
      height: 105,
      wallets: [A, B, C],
      keysBefore: { [A]: `${A}-${B}`, [B]: `${A}-${B}`, [C]: C },
      keysAfter: { [A]: key, [B]: key, [C]: key }
    });
  });

  it('tells the membership handlers nothing when no key changes', async () => {
    const { mirror, chain, alice, changes } = world();
    await mirror.run({ budgetMs: 60_000 });
    changes.length = 0;
    chain.identities.set(alice.principalId, {
      ...alice,
      rep: { total: '6', raters: 1 }
    });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        {
          height: 101,
          slot: 0,
          root: '0x',
          time: 0,
          records: [
            {
              family: '0x0201',
              name: 'Principal',
              key: '0x',
              value: null,
              keyFields: { principal: alice.principalId }
            }
          ]
        }
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(changes).toEqual([]);
  });

  it('logs a rating change found on the feed at the feed height', async () => {
    const { mirror, db, chain, alice, bob } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.ratingReads = [];
    chain.feed.push({
      from: 101,
      through: 103,
      next: 104,
      blocks: [
        {
          height: 102,
          slot: 0,
          root: '0x',
          time: 0,
          records: [
            {
              family: '0x0301',
              name: 'Rating',
              key: '0x',
              value: null,
              keyFields: { rater: bob.principalId, target: alice.principalId }
            }
          ]
        }
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.ratingReads.map((it) => it.events)).toContainEqual({
      targetPrincipal: alice.principalId,
      height: 103,
      source: 'FEED'
    });
  });

  it('starts a full sync when the feed no longer holds its height', async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      gateway.getChanges.mockRejectedValueOnce(
        new ChainGatewayError('gone', 410, 'gone', '/v1/feed')
      );
    }
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.sync_phase).toBe('IDENTITIES');
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.sync_phase).toBeNull();
  });

  it('runs a full sync again after six hours', async () => {
    const { mirror, gateway, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    gateway.listIdentities.mockClear();
    tick(6 * 60 * 60 * 1000 + 1);
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.mode).toBe('full_sync');
    expect(gateway.listIdentities).toHaveBeenCalled();
  });

  it('leaves an identity with more wallets than a key holds alone', async () => {
    const { mirror, db, chain } = world();
    const many = Array.from({ length: 5 }, (_, i) => W(100 + i));
    chain.identities.set(PID(9), chainIdentity(PID(9), many));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.skippedTooManyWallets).toEqual([PID(9)]);
    expect(Array.from(db.addressKeys.keys())).not.toContain(many[0]);
  });

  it('writes a five-wallet identity once the key columns are wide', async () => {
    const { mirror, db, chain } = world();
    db.keyWidth = 700;
    const many = Array.from({ length: 5 }, (_, i) => W(100 + i));
    chain.identities.set(PID(9), chainIdentity(PID(9), many));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.skippedTooManyWallets).toEqual([]);
    expect(db.addressKeys.get(many[0])).toBe(many.join('-'));
  });
});

describe('feedEffects', () => {
  it('reads principals, wallets, ratings and delegations from records', () => {
    const effects = feedEffects([
      {
        family: '0x0101',
        name: 'Principal',
        key: '0x',
        value: null,
        keyFields: { principalId: PID(1) },
        valueFields: { anchor: A, root: PID(77) }
      },
      {
        family: '0x0701',
        name: 'Rating',
        key: '0x',
        value: null,
        keyFields: { rater: PID(2), target: PID(3), categoryId: PID(5) },
        valueFields: null
      },
      {
        family: '0x0120',
        name: 'Delegation',
        key: '0x',
        value: null,
        keyFields: { holder: B, useCase: 2 },
        valueFields: { delegate: W(9) }
      }
    ]);
    // A rating's ends are refreshed as identities too (their totals moved).
    expect(Array.from(effects.principals).sort()).toEqual([
      PID(1),
      PID(2),
      PID(3)
    ]);
    expect(Array.from(effects.wallets)).toEqual([A]);
    expect(Array.from(effects.ratingTargets).sort()).toEqual([PID(2), PID(3)]);
    expect(Array.from(effects.delegationHolders).sort()).toEqual(
      [B, W(9)].sort()
    );
  });
});

describe('toDelegationRow', () => {
  it('keeps an imported record at its Ethereum block', () => {
    expect(
      toDelegationRow(
        A,
        delegation(A, 'wallet', {
          source: 'imported',
          ethBlock: 18_000_000,
          allTokens: false,
          tokenId: '61',
          expiry: '1900000000'
        })
      )
    ).toEqual({
      block: 18_000_000,
      from_address: A,
      to_address: W(9),
      collection: W(0x8888),
      use_case: 2,
      expiry: 1_900_000_000,
      all_tokens: false,
      token_id: 61
    });
  });

  it('skips a token id the column can not hold', () => {
    expect(
      toDelegationRow(
        A,
        delegation(A, 'wallet', {
          allTokens: false,
          tokenId: '0x' + 'ff'.repeat(32)
        })
      )
    ).toBeNull();
  });
});

describe('pickWalletProfile', () => {
  it('prefers a real handle, then the anchor wallet, then the lowest id', () => {
    const placeholderAnchor = {
      profile_id: 'b',
      handle: `id-${A}`,
      address: A
    };
    const placeholderOther = { profile_id: 'a', handle: `id-${B}`, address: B };
    const real = { profile_id: 'c', handle: 'carol', address: C };
    expect(
      pickWalletProfile([placeholderAnchor, placeholderOther, real], A)
    ).toBe('c');
    expect(pickWalletProfile([placeholderOther, placeholderAnchor], A)).toBe(
      'b'
    );
    expect(pickWalletProfile([placeholderAnchor, placeholderOther], null)).toBe(
      'a'
    );
    expect(pickWalletProfile([], A)).toBeNull();
  });
});

describe('IdentityChainMirror edge cases', () => {
  it('writes the identity a merged one went into, not the merged one', async () => {
    const { mirror, db, chain, alice } = world();
    chain.identities.set(PID(5), {
      ...chainIdentity(PID(5), []),
      status: 'merged',
      mergedInto: alice.principalId
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.skippedInactive).toContain(PID(5));
    expect(report.failed).toEqual([]);
    expect(db.mapping.has(PID(5))).toBe(false);
  });

  it('goes on with the others when one identity fails', async () => {
    const { mirror, db, bob } = world();
    const apply = db.applyIdentityPlan.bind(db);
    jest
      .spyOn(db, 'applyIdentityPlan')
      .mockImplementation(async (plan: IdentityPlan) => {
        if (plan.profile.handle === 'bob') throw new Error('duplicate');
        return apply(plan);
      });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.failed).toEqual([`${bob.principalId}: duplicate`]);
    expect(db.state?.sync_phase).toBeNull();
    expect(db.rows.size).toBeGreaterThan(0);
  });

  it('asks again before giving up on a feed height', async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    gateway.getChanges.mockRejectedValueOnce(
      new ChainGatewayError('gone', 410, 'gone', '/v1/feed')
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.sync_phase).toBeNull();
    expect(gateway.getChanges).toHaveBeenCalledTimes(3);
  });
});

describe('feedEffects address words', () => {
  it('reads a holder word as its wallet', () => {
    const word = '0x' + '0'.repeat(24) + B.slice(2);
    const effects = feedEffects([
      {
        family: '0x0120',
        name: 'Delegation',
        key: '0x',
        value: null,
        keyFields: { holder: word, scope: 2 },
        valueFields: null
      }
    ]);
    expect(Array.from(effects.delegationHolders)).toEqual([B]);
  });
});
