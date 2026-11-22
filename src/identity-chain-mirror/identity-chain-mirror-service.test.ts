import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  ChainDelegation,
  ChainFeedPage,
  ChainIdentity,
  ChainRating
} from '@/chain-gateway/chain-gateway.types';
import {
  DelegationRowWrite,
  FirstBinding,
  IdentityChainMirrorDb,
  MirrorState,
  RatingEventContext,
  RatingRowWrite
} from './identity-chain-mirror.db';
import { IdentityChainLookups } from './identity-chain-lookups';
import { MembershipChange } from './membership-change';
import { ProfileSiteFollower } from './profile-site-port';
import { WalletBindingRow } from './wallet-bindings';
import {
  feedEffects,
  IdentityChainMirror,
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
// Distinct in their first 16 bytes, as real principal ids are.
const PID = (n: number) =>
  `0x${n.toString(16).padStart(8, '0')}${'ab'.repeat(28)}`;
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
  bindings = new Map<string, WalletBindingRow>();
  firstBindings = new Map<string, FirstBinding>();
  regroups = new Map<string, number>();
  keptPairWallets: string[] = [];

  async recordFirstBindings(rows: FirstBinding[]) {
    rows.forEach((it) => {
      if (!this.firstBindings.has(it.wallet)) {
        this.firstBindings.set(it.wallet, it);
      }
    });
  }
  async firstBindingOf(wallet: string) {
    return {
      first: this.firstBindings.get(wallet.toLowerCase()) ?? null,
      exact: !!this.state?.bindings_exact,
      nextHeight: this.state?.bindings_next_height ?? null
    };
  }
  async queueRegroups(wallets: string[], now: number) {
    wallets.forEach((it) => this.regroups.set(it, now));
  }
  async pendingRegroups(limit: number) {
    return Array.from(this.regroups.keys()).slice(0, limit);
  }
  async regroupsDone(wallets: string[], before: number) {
    wallets.forEach((it) => {
      if ((this.regroups.get(it) ?? Infinity) <= before) {
        this.regroups.delete(it);
      }
    });
  }
  levelWrites: { profile_id: string; level_raw: number }[][] = [];
  async writeLevels(levels: { profile_id: string; level_raw: number }[]) {
    this.levelWrites.push(levels);
    let written = 0;
    for (const it of levels) {
      for (const [key, row] of Array.from(this.rows.entries())) {
        if (row.profile_id === it.profile_id) {
          this.rows.set(key, { ...row, level_raw: it.level_raw });
          written++;
        }
      }
    }
    return written;
  }
  async profileIdsOfPrincipals(principals: string[]) {
    const result = new Map<string, string>();
    principals.forEach((p) => {
      const mapped = this.mapping.get(p.toLowerCase());
      if (mapped) result.set(p.toLowerCase(), mapped.profile);
    });
    return result;
  }

  async walletBindings(wallets: string[]) {
    return new Map(
      wallets
        .filter((w) => this.bindings.has(w))
        .map((w) => [w, this.bindings.get(w)!] as const)
    );
  }
  async writeWalletBindings(upserts: WalletBindingRow[], deletes: string[]) {
    deletes.forEach((w) => this.bindings.delete(w));
    upserts.forEach((row) => this.bindings.set(row.wallet, row));
  }
  async boundWallets() {
    return Array.from(this.bindings.keys());
  }
  async clearWalletBindings() {
    this.bindings.clear();
    this.firstBindings.clear();
  }
  async walletBindingAt(wallet: string) {
    return {
      binding: this.bindings.get(wallet) ?? null,
      nextHeight: this.state?.bindings_next_height ?? null,
      chainId: this.state?.chain_id ?? null
    };
  }

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
  placeholders = new Map<string, string>();
  async clearChainMadeMappings() {
    for (const [principal, it] of Array.from(this.mapping.entries())) {
      if (it.origin !== 'LEGACY') this.mapping.delete(principal);
    }
  }
  async listPlaceholderProfiles(): Promise<string | null> {
    const mapped = new Set(
      Array.from(this.mapping.values()).map((it) => it.profile)
    );
    for (const profile of Array.from(this.profiles.values())) {
      const wallet = profile.primary_wallet.toLowerCase();
      if (
        profile.normalised_handle === `id-${wallet}` &&
        !mapped.has(profile.external_id) &&
        !this.placeholders.has(wallet)
      ) {
        this.placeholders.set(wallet, profile.external_id);
      }
    }
    return null;
  }
  async unmappedPlaceholderProfile(wallet: string) {
    const mapped = new Set(
      Array.from(this.mapping.values()).map((it) => it.profile)
    );
    const profile = this.placeholders.get(wallet.toLowerCase());
    return profile && !mapped.has(profile) ? profile : null;
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
  async replaceAllPairs(
    pairs: { wallet1: string; wallet2: string }[],
    _block: number,
    _now: number,
    _conn: unknown,
    keep: string[] = []
  ) {
    this.keptPairWallets = keep;
    this.pairs = [
      ...this.pairs.filter(
        (it) => keep.includes(it.wallet1) || keep.includes(it.wallet2)
      ),
      ...pairs
    ];
  }
  async replaceTargetRatings(
    target: string,
    rows: RatingRowWrite[],
    _now: number,
    events: RatingEventContext,
    _conn?: unknown,
    { keepRaters = [] }: { keepRaters?: readonly string[] } = {}
  ) {
    const key = (it: RatingRowWrite) =>
      `${it.rater_profile_id}|${it.matter}|${it.matter_category}`;
    const listed = new Set(rows.map(key));
    const kept = (this.ratings.get(target) ?? []).filter(
      (it) => !listed.has(key(it)) && keepRaters.includes(it.rater_profile_id)
    );
    this.ratings.set(target, [...kept, ...rows]);
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

/** A feed page as a test writes it; the fake adds what the client derives. */
type FeedPage = Omit<ChainFeedPage, 'nextHeight' | 'atHead'> & {
  from: number;
  next: number;
};

const NOTHING_TO_RETRY = { principals: [], targets: [], wallets: [] };

/**
 * As after a membership list: the mirror's first bindings aren't exact, so
 * the gateway's history says which identity a wallet was first bound to.
 */
function historyDecides(db: FakeDb) {
  db.state = { ...db.state!, bindings_exact: false };
}

/** A gateway over a little chain the test edits. */
function world(followers: ProfileSiteFollower[] = []) {
  const alice = chainIdentity(PID(1), [A, B], {
    handle: 'alice',
    legacyId: ALICE_PROFILE,
    rep: { total: '5', raters: 1 },
    level: {
      level: 6,
      raw: '1005',
      rep: '5',
      tdh: '1000',
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
    feed: [] as FeedPage[],
    importCompleted: true,
    importStart: null as number | null,
    importDone: null as number | null,
    fileHash: '0x' + 'f1'.repeat(32),
    network: null as string | null,
    headHeldAt: null as number | null,
    finalized: 100
  };
  const gateway = {
    // The gateway's finalized height reaches what its feed gives, unless a
    // test holds it back.
    getHead: jest.fn(async () => {
      const finalized =
        chain.headHeldAt ??
        Math.max(chain.finalized, ...chain.feed.map((it) => it.through));
      return {
        headHeight: finalized + 2,
        finalizedHeight: finalized,
        finalizedTime: 0,
        pinnable: null,
        network: chain.network
      };
    }),
    getMembership: jest.fn(async () => ({
      import: {
        completed: chain.importCompleted,
        startHeight: chain.importStart,
        doneHeight: chain.importDone,
        fileHash: chain.fileHash
      }
    })),
    listMembershipWallets: jest.fn(async (opts: { height?: number }) => ({
      items: Array.from(chain.identities.values()).flatMap((it) =>
        it.wallets.map((wallet) => ({ wallet, principalId: it.principalId }))
      ),
      next: null,
      read: { height: opts.height ?? chain.finalized } as never
    })),
    getMembershipWalletHistory: jest.fn(async (wallet: string) => {
      const owner = Array.from(chain.identities.values()).find((it) =>
        it.wallets.includes(wallet)
      );
      return {
        wallet,
        changes: owner ? [{ height: 3, principalId: owner.principalId }] : [],
        ranges: [[1, 1000]] as [number, number][],
        readHeight: chain.finalized
      };
    }),
    getImportedIdentity: jest.fn(async () => null),
    getMembershipWallet: jest.fn(async (wallet: string) => {
      const owner = Array.from(chain.identities.values()).find((it) =>
        it.wallets.includes(wallet)
      );
      return owner
        ? {
            wallet,
            principalId: owner.principalId,
            firstBoundHeight: owner.createdHeight
          }
        : { wallet, principalId: null };
    }),
    getDocument: jest.fn(async () => null),
    putDocument: jest.fn(),
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
    // Active identities by the raw level the test sets, highest first.
    getLevelRanking: jest.fn(
      async (opts: { after?: string | null; limit?: number } = {}) => {
        const ranked = Array.from(chain.identities.values())
          .filter((it) => it.level)
          .sort((a, b) => Number(b.level!.raw) - Number(a.level!.raw));
        const start = opts.after
          ? ranked.findIndex((it) => it.principalId === opts.after) + 1
          : 0;
        const rows = ranked.slice(start, start + (opts.limit ?? 500));
        const last = rows[rows.length - 1];
        return {
          read: { network: chain.network } as never,
          data: {
            rankedAt: chain.finalized,
            count: ranked.length,
            rows: rows.map((identity, i) => ({
              rank: start + i + 1,
              level: identity.level!.level,
              raw: identity.level!.raw,
              identity
            }))
          },
          next: start + rows.length < ranked.length ? last.principalId : null
        };
      }
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
    // The feed's pages by their first height; with a family filter, only
    // those records (and the blocks that have some).
    getChanges: jest.fn(
      async (
        from: number | string,
        opts: { families?: string[] } = {}
      ): Promise<ChainFeedPage> => {
        const found = chain.feed.find((it) => String(it.from) === String(from));
        if (!found) {
          const height = Number(String(from).split(':')[0]);
          return {
            from,
            through: height - 1,
            blocks: [],
            next: from,
            nextHeight: height,
            atHead: true
          };
        }
        const page = {
          ...found,
          nextHeight: found.through + 1,
          atHead: false
        };
        if (!opts.families) return page;
        const families = opts.families;
        return {
          ...page,
          blocks: page.blocks
            .map((block) => ({
              ...block,
              records: block.records.filter((it) =>
                families.includes(it.family)
              )
            }))
            .filter((block) => block.records.length)
        };
      }
    )
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
    ],
    followers,
    async () => undefined
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
              keyFields: { address: C },
              valueFields: { principalId: alice.principalId }
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
    // Queued for re-keying with the new keys, kept until it is done.
    expect(Array.from(db.regroups.keys())).toEqual(expect.arrayContaining([C]));
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
    // Three tries each for the bindings, then for the identities.
    for (let i = 0; i < 6; i++) {
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

  const bind = (wallet: string, principal: string | null) => ({
    family: '0x0102',
    name: 'AddressBinding',
    key: `0x0102${wallet.slice(2)}`,
    value: principal ? '0x01' : null,
    keyFields: { address: wallet },
    valueFields: principal ? { principalId: principal } : null
  });
  const block = (
    height: number,
    records: ChainFeedPage['blocks'][0]['records']
  ) => ({
    height,
    slot: 0,
    root: '0x',
    time: 0,
    records
  });

  it('lists the wallet bindings, bound since the list, without a feed to replay', async () => {
    const { mirror, db, alice, bob, gateway } = world();
    // A row from before, for a wallet no longer bound.
    db.bindings.set(W(7), {
      wallet: W(7),
      principal_id: bob.principalId,
      bound_from_height: 2
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(gateway.listMembershipWallets).toHaveBeenCalledWith({
      after: null,
      limit: 5000,
      height: 100
    });
    expect(report.walletBindings).toBe(4);
    expect(report.bindingsNextHeight).toBe(101);
    // Only the list's height is known: later than the truth, never earlier.
    expect(db.bindings.get(B)).toEqual({
      wallet: B,
      principal_id: alice.principalId,
      bound_from_height: 100
    });
    expect(db.bindings.get(C)?.principal_id).toBe(bob.principalId);
    expect(db.bindings.has(W(7))).toBe(false);
    const lookups = new IdentityChainLookups(
      db as unknown as IdentityChainMirrorDb,
      gateway as never
    );
    gateway.getMembershipWalletHistory.mockResolvedValue(null as never);
    expect(await lookups.walletPrincipalAt(B, 100)).toBe(alice.principalId);
    // Before the list: the chain's history, here none, so unknown.
    await expect(lookups.walletPrincipalAt(B, 99)).rejects.toThrow(
      'is not known'
    );
  });

  it('tries the list again next run when it does not read at one height', async () => {
    const { mirror, db, gateway } = world();
    gateway.listMembershipWallets.mockRejectedValueOnce(
      new ChainGatewayError('gone', 409, 'height_gone', '/v1/membership')
    );
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(first.bindingsNextHeight).toBeNull();
    expect(db.bindings.size).toBe(0);
    const second = await mirror.run({ budgetMs: 60_000 });
    expect(second.bindingsNextHeight).toBe(101);
  });

  it('follows the bindings on the feed from the import, apart from the identities', async () => {
    const { mirror, db, chain, alice, gateway } = world();
    chain.importStart = 1;
    // A row from before the cursor existed: the table starts empty.
    db.bindings.set(W(9), {
      wallet: W(9),
      principal_id: PID(9),
      bound_from_height: 1
    });
    chain.feed.push({
      from: 1,
      through: 120,
      next: 121,
      blocks: [
        block(2, [bind(A, alice.principalId)]),
        block(4, [bind(B, alice.principalId)]),
        block(110, [bind(B, null)]),
        block(112, [bind(C, alice.principalId)])
      ]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(gateway.listMembershipWallets).not.toHaveBeenCalled();
    expect(gateway.getChanges).toHaveBeenCalledWith(1, {
      limit: 200,
      families: ['0x0102']
    });
    expect(report.bindingsNextHeight).toBe(121);
    expect(
      Array.from(db.bindings.values()).map((it) => [
        it.wallet,
        it.bound_from_height
      ])
    ).toEqual([
      [A, 2],
      [C, 112]
    ]);
    const lookups = new IdentityChainLookups(
      db as unknown as IdentityChainMirrorDb,
      gateway as never
    );
    expect(await lookups.walletPrincipalAt(A, 120)).toBe(alice.principalId);
    expect(await lookups.walletPrincipalAt(C, 115)).toBe(alice.principalId);
  });

  it('waits for the feed without moving the bindings, while the identities go on', async () => {
    const { mirror, db, chain, gateway, alice } = world();
    chain.importStart = 1;
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(first.bindingsNextHeight).toBe(1);
    expect(gateway.listIdentities).toHaveBeenCalled();
    chain.feed.push({
      from: 1,
      through: 5,
      next: 6,
      blocks: [block(3, [bind(A, alice.principalId)])]
    });
    const second = await mirror.run({ budgetMs: 60_000 });
    expect(second.bindingsNextHeight).toBe(6);
    expect(db.bindings.get(A)?.bound_from_height).toBe(3);
  });

  it('drops a row whose binding it cannot read, and lists the membership past a wallet it cannot read', async () => {
    const { mirror, db, chain, alice, bob } = world();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.bindings.has(A)).toBe(true);
    chain.finalized = 110;
    chain.feed.push({
      from: 101,
      through: 110,
      next: 111,
      blocks: [
        block(102, [
          { ...bind(A, alice.principalId), valueFields: { principal: 'x' } }
        ]),
        block(105, [{ ...bind(B, null), keyFields: {} }]),
        block(107, [bind(C, alice.principalId)])
      ]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.bindingProblems).toEqual([
      `102:${bind(A, null).key}`,
      `105:${bind(B, null).key}`
    ]);
    // Listed at the head instead: the cursor moves past the block.
    expect(report.bindingsNextHeight).toBe(111);
    expect(db.bindings.get(C)).toEqual({
      wallet: C,
      principal_id: bob.principalId,
      bound_from_height: 110
    });
  });

  it('starts again on another chain, also while its import runs, but not for a lagging node', async () => {
    const { mirror, db, chain, alice } = world();
    const stale = () =>
      db.bindings.set(W(9), {
        wallet: W(9),
        principal_id: PID(9),
        bound_from_height: 50
      });
    // No network id from the gateway: nothing to compare.
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.chain_id).toBeNull();
    chain.network = '0x' + 'aa'.repeat(32);
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.chain_id).toBe(chain.network);
    expect(db.state?.next_height).toBe(101);
    // A relaunch: another network. Bindings and identity tables start again.
    db.mapping.set(PID(98), { profile: 'made-on-old-chain', origin: 'NEW' });
    stale();
    chain.network = '0x' + 'bb'.repeat(32);
    chain.importCompleted = false;
    const during = await mirror.run({ budgetMs: 60_000 });
    expect(during.skipped).toBe('import_not_complete');
    expect(db.state?.chain_id).toBe(chain.network);
    expect(db.state?.next_height).toBeNull();
    expect(db.state?.bindings_next_height).toBeNull();
    expect(db.bindings.has(W(9))).toBe(false);
    expect(db.mapping.has(PID(98))).toBe(false);
    expect(db.mapping.get(alice.principalId)?.origin).toBe('LEGACY');
    expect(db.state?.placeholders_at).toBe(1_000);
    chain.importCompleted = true;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(101);
    // The same network with the cursor ahead of this node's head (another
    // node behind it) is not a reset.
    db.state = { ...db.state!, bindings_next_height: 500 };
    stale();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.bindings.has(W(9))).toBe(true);
  });

  it('follows a block the gateway cut, keeping the whole height between runs', async () => {
    const { mirror, db, chain, gateway, alice } = world();
    chain.importStart = 1;
    const part = (
      complete: boolean,
      records: ChainFeedPage['blocks'][0]['records']
    ) => ({
      height: 2,
      slot: 0,
      root: '0x',
      time: 0,
      complete,
      // The rest of the block starts where the cursor `2:1` says.
      recordsFrom: complete ? 1 : 0,
      records
    });
    gateway.getChanges.mockImplementation(
      async (from: string | number, opts: { families?: string[] } = {}) => {
        if (!opts.families) {
          return {
            from,
            through: 0,
            blocks: [],
            next: from,
            nextHeight: Number(from),
            atHead: true
          };
        }
        if (String(from) === '1') {
          return {
            from,
            through: 1,
            next: '2:1',
            nextHeight: 2,
            atHead: false,
            blocks: [part(false, [bind(A, alice.principalId)])]
          };
        }
        if (String(from) === '2:1') {
          return {
            from,
            through: 2,
            next: '3',
            nextHeight: 3,
            atHead: false,
            blocks: [part(true, [bind(B, alice.principalId)])]
          };
        }
        return {
          from,
          through: 2,
          blocks: [],
          next: from,
          nextHeight: 3,
          atHead: true
        };
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.bindings.get(A)?.bound_from_height).toBe(2);
    expect(db.bindings.get(B)?.bound_from_height).toBe(2);
    expect(db.state?.bindings_next_height).toBe(3);
    expect(gateway.getChanges).toHaveBeenCalledWith('2:1', {
      limit: 200,
      families: ['0x0102']
    });
  });

  it('confirms no legacy id only for an identity made before the import ended', async () => {
    const { mirror, chain, gateway } = world();
    chain.importDone = 50;
    await mirror.run({ budgetMs: 60_000 });
    gateway.getImportedIdentity.mockClear();
    const late = chainIdentity(PID(52), [W(52)], {
      legacyId: null,
      createdHeight: 60
    });
    expect(await mirror.profileIdOf(late)).toBe(principalProfileId(PID(52)));
    expect(gateway.getImportedIdentity).not.toHaveBeenCalled();
    const early = chainIdentity(PID(53), [W(53)], {
      legacyId: null,
      createdHeight: 40
    });
    await mirror.profileIdOf(early);
    // Made in the import's last block: asked too.
    const atEnd = chainIdentity(PID(54), [W(54)], {
      legacyId: null,
      createdHeight: 50
    });
    await mirror.profileIdOf(atEnd);
    expect(gateway.getImportedIdentity).toHaveBeenCalledTimes(2);
  });

  it('reads an identity again for each feed page, at a height that includes it', async () => {
    const { mirror, db, chain, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    const touch = (height: number) => ({
      from: height,
      through: height,
      next: height + 1,
      blocks: [
        block(height, [
          {
            family: '0x0201',
            name: 'Principal',
            key: '0x',
            value: null,
            keyFields: { principal: alice.principalId }
          }
        ])
      ]
    });
    chain.finalized = 102;
    chain.feed.push(touch(101), touch(102));
    // Alice's REP changes in block 102: the second page must read it again.
    let aliceReads = 0;
    gateway.getIdentityByPrincipal.mockImplementation(async (p: string) => {
      const identity = chain.identities.get(p) ?? null;
      if (!identity || p !== alice.principalId) return identity;
      aliceReads++;
      return aliceReads >= 2
        ? { ...identity, rep: { total: '50', raters: 1 } }
        : identity;
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(103);
    expect(db.rows.get(`${A}-${B}`)?.rep).toBe(50);
  });

  it('waits for the next run when the reads lag behind the feed', async () => {
    const { mirror, db, chain } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [block(104, [])]
    });
    // The gateway's finalized height is still 100.
    chain.headHeldAt = 100;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(101);
    chain.headHeldAt = null;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(106);
  });

  it('maps NEW and leaves the placeholder for a later merge when no history can ever say', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(99), 'p-maybe');
    // The node's feed starts after the import: it never will say.
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(99),
      changes: [{ height: 20, principalId: PID(99) }],
      ranges: [[5, 100]],
      readHeight: 100
    } as never);
    const made = chainIdentity(PID(99), [W(99)], {
      legacyId: null,
      founder: W(99),
      createdHeight: 20
    });
    expect(await mirror.profileIdOf(made)).toBe(principalProfileId(PID(99)));
    expect(db.mapping.get(PID(99))?.origin).toBe('NEW');
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.orphanedProfiles).toContain('p-maybe');
    // A binding to another identity first says no, whatever the gap.
    db.mapping.delete(PID(99));
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(99),
      changes: [
        { height: 6, principalId: PID(98) },
        { height: 10, principalId: null },
        { height: 20, principalId: PID(99) }
      ],
      ranges: [[5, 100]],
      readHeight: 100
    } as never);
    expect(await mirror.profileIdOf(made)).toBe(principalProfileId(PID(99)));
    expect((await mirror.run({ budgetMs: 60_000 })).orphanedProfiles).toEqual(
      []
    );
  });

  it('waits for a node whose history is behind, and answers from a whole one', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(99), 'p-maybe');
    const made = chainIdentity(PID(99), [W(99)], {
      legacyId: null,
      founder: W(99),
      createdHeight: 20
    });
    // Held from the import without a gap, but only to 15.
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(99),
      changes: [],
      ranges: [[1, 15]],
      readHeight: 15
    } as never);
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      retryLater: true,
      reason: 'history_behind'
    });
    expect(db.mapping.has(PID(99))).toBe(false);
    // The whole history: bound to it at its creation, to another later.
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(99),
      changes: [
        { height: 20, principalId: PID(99) },
        { height: 30, principalId: PID(98) }
      ],
      ranges: [[1, 100]],
      readHeight: 100
    } as never);
    expect(await mirror.profileIdOf(made)).toBe('p-maybe');
  });

  it('answers from a history held from the import, not from the first block', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 10;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(97), 'p-from-import');
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(97),
      changes: [{ height: 20, principalId: PID(97) }],
      ranges: [[10, 100]],
      readHeight: 100
    } as never);
    const made = chainIdentity(PID(97), [W(97)], {
      legacyId: null,
      founder: W(97),
      createdHeight: 20
    });
    expect(await mirror.profileIdOf(made)).toBe('p-from-import');
  });

  it("gives the founder's placeholder from the mirror's own first bindings", async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    chain.feed.push({
      from: 1,
      through: 30,
      next: 31,
      blocks: [
        block(20, [bind(W(96), PID(96))]),
        block(25, [bind(W(95), PID(95))]),
        block(26, [bind(W(96), null)]),
        block(28, [bind(W(96), PID(94))])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.bindings_exact).toBe(true);
    expect(db.firstBindings.get(W(96))).toEqual({
      wallet: W(96),
      principal_id: PID(96),
      height: 20
    });
    db.placeholders.set(W(96), 'p-96');
    gateway.getMembershipWalletHistory.mockClear();
    const first = chainIdentity(PID(96), [W(96)], {
      legacyId: null,
      founder: W(96),
      createdHeight: 20
    });
    const second = chainIdentity(PID(94), [W(96)], {
      legacyId: null,
      founder: W(96),
      createdHeight: 28
    });
    expect(await mirror.profileIdOf(second)).toBe(principalProfileId(PID(94)));
    expect(await mirror.profileIdOf(first)).toBe('p-96');
    expect(gateway.getMembershipWalletHistory).not.toHaveBeenCalled();
    // Created past where the bindings have followed: asked again later.
    const later = chainIdentity(PID(93), [W(93)], {
      legacyId: null,
      founder: W(93),
      createdHeight: 40
    });
    db.placeholders.set(W(93), 'p-93');
    await expect(mirror.profileIdOf(later)).rejects.toMatchObject({
      reason: 'bindings_behind'
    });
    // A membership list ends the exact record: new firsts aren't kept.
    db.state = { ...db.state!, bindings_exact: false };
    chain.feed.push({
      from: 31,
      through: 40,
      next: 41,
      blocks: [block(40, [bind(W(93), PID(93))])]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.firstBindings.has(W(93))).toBe(false);
    expect(db.firstBindings.has(W(96))).toBe(true);
  });

  it('keeps no first bindings once the bindings come from a membership list', async () => {
    const { mirror, db, chain, gateway } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.bindings_exact).toBe(true);
    // The feed no longer holds the bindings' height: listed instead.
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        if (opts?.families) {
          throw new ChainGatewayError('gone', 410, 'gone', '/v1/feed');
        }
        return await changesOf(from, opts);
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.listMembershipWallets).toHaveBeenCalled();
    expect(db.state?.bindings_exact).toBe(false);
  });

  it('keeps no first bindings past a binding whose principal cannot be read', async () => {
    const { mirror, db, chain } = world();
    chain.importStart = 1;
    chain.feed.push({
      from: 1,
      through: 10,
      next: 11,
      blocks: [
        block(4, [
          { ...bind(W(91), PID(91)), valueFields: { principalId: 'x' } }
        ]),
        block(6, [bind(W(92), PID(92))])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.bindings_exact).toBe(false);
    expect(db.firstBindings.size).toBe(0);
  });

  it('maps NEW without the import start, end to end, leaving the placeholder', async () => {
    const { mirror, db, chain } = world();
    chain.importStart = null;
    const founder = W(89);
    db.profiles.set('p-89', {
      external_id: 'p-89',
      handle: `id-${founder}`,
      normalised_handle: `id-${founder}`,
      primary_wallet: founder,
      pfp_url: null,
      banner_1: null,
      banner_2: null,
      website: null,
      classification: null,
      sub_classification: null
    });
    // Bound to it at its creation (3), as the gateway's history shows.
    const made = chainIdentity(PID(89), [founder], {
      legacyId: null,
      founder
    });
    chain.identities.set(made.principalId, made);
    const report = await mirror.run({ budgetMs: 60_000 });
    // The bindings come from a membership list: not exact.
    expect(db.state?.bindings_exact).toBe(false);
    expect(db.mapping.get(made.principalId)).toEqual({
      profile: principalProfileId(PID(89)),
      origin: 'NEW'
    });
    expect(report.orphanedProfiles).toContain('p-89');
  });

  it('gives no placeholder to an identity its founder wallet joined after the creation', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(88), 'p-late');
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(88),
      changes: [{ height: 25, principalId: PID(88) }],
      ranges: [[1, 100]],
      readHeight: 100
    } as never);
    const made = chainIdentity(PID(88), [W(88)], {
      legacyId: null,
      founder: W(88),
      createdHeight: 20
    });
    expect(await mirror.profileIdOf(made)).toBe(principalProfileId(PID(88)));
  });

  it('reads no bindings from a feed page of another chain', async () => {
    const { mirror, db, chain, alice } = world();
    chain.importStart = 1;
    chain.network = '0xmain';
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.bindings_next_height).toBe(1);
    chain.feed.push({
      from: 1,
      through: 5,
      next: 6,
      network: '0xother',
      blocks: [block(3, [bind(A, alice.principalId)])]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.bindingsNextHeight).toBe(1);
    expect(db.bindings.has(A)).toBe(false);
  });

  it('tries again next run what a feed page could not write', async () => {
    const { mirror, db, chain, alice } = world();
    await mirror.run({ budgetMs: 60_000 });
    jest.spyOn(db, 'applyIdentityPlan').mockImplementationOnce(async () => {
      throw new Error('deadlock');
    });
    chain.identities.set(alice.principalId, { ...alice, handle: 'alice2' });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        block(101, [
          {
            family: '0x0201',
            name: 'Principal',
            key: '0x',
            value: null,
            keyFields: { principal: alice.principalId }
          }
        ])
      ]
    });
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(first.failed).toEqual([`${alice.principalId}: deadlock`]);
    // The page is done; the identity is kept to try again.
    expect(db.state?.next_height).toBe(102);
    expect(db.state?.retry.principals).toEqual([alice.principalId]);
    expect(first.retryLeft).toBe(1);
    const second = await mirror.run({ budgetMs: 60_000 });
    expect(second.failed).toEqual([]);
    expect(second.retryLeft).toBe(0);
    expect(db.state?.retry).toEqual(NOTHING_TO_RETRY);
    expect(db.profiles.get(ALICE_PROFILE)?.handle).toBe('alice2');
  });

  it('drops a key to retry that the chain no longer has, and syncs a wallet again', async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      retry: { principals: [PID(77)], targets: [PID(77)], wallets: [W(77)] }
    };
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledWith(PID(77), {
      height: 100
    });
    expect(gateway.getDelegationsOfWallet).toHaveBeenCalledWith(W(77), {
      height: 100
    });
    expect(db.state?.retry).toEqual(NOTHING_TO_RETRY);
  });

  it('tries at most 500 keys again a run, and starts a full sync past 10,000', async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    const keys = (n: number) =>
      Array.from({ length: n }, (_, i) => PID(1000 + i));
    db.state = {
      ...db.state!,
      retry: { principals: keys(600), targets: [], wallets: [] }
    };
    gateway.getIdentityByPrincipal.mockClear();
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledTimes(500);
    // Gone from the chain: dropped; the 100 not reached wait for next run.
    expect(first.retryLeft).toBe(100);
    db.state = {
      ...db.state!,
      retry: { principals: keys(10_001), targets: [], wallets: [] }
    };
    gateway.getIdentityByPrincipal.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    // None is read one by one: the full sync starts (the next run goes on).
    expect(gateway.getIdentityByPrincipal).not.toHaveBeenCalled();
    expect(db.state?.sync_phase).toBe('IDENTITIES');
    expect(db.state?.retry).toEqual(NOTHING_TO_RETRY);
  });

  it('reads a feed page at one height at or past it, also when the head goes back', async () => {
    const { mirror, db, chain, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.finalized = 105;
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [
        block(105, [
          {
            family: '0x0201',
            name: 'Principal',
            key: '0x',
            value: null,
            keyFields: { principal: alice.principalId }
          }
        ])
      ]
    });
    // After the page is pinned, another node answers the status, behind.
    const head = gateway.getHead.getMockImplementation()!;
    let calls = 0;
    gateway.getHead.mockImplementation(async () => {
      const it = await head();
      calls++;
      return calls > 3 ? { ...it, finalizedHeight: 99 } : it;
    });
    gateway.getIdentityByPrincipal.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(106);
    expect(gateway.getIdentityByPrincipal.mock.calls).toEqual([
      [alice.principalId, { height: 105 }]
    ]);
  });

  it('stops without moving on when a pinned read is refused, and fails nothing', async () => {
    const { mirror, db, chain, alice, bob, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        block(101, [
          {
            family: '0x0301',
            name: 'Rating',
            key: '0x',
            value: null,
            keyFields: { rater: bob.principalId, target: alice.principalId }
          }
        ])
      ]
    });
    const gone = new ChainGatewayError(
      'gone',
      409,
      'height_gone',
      '/v1/ratings'
    );
    // Gone at an identity read, then at one target's ratings read.
    gateway.getIdentityByPrincipal.mockRejectedValueOnce(gone);
    const failing = [
      () => undefined,
      () => gateway.getRatings.mockRejectedValueOnce(gone),
      () =>
        gateway.getRatings.mockRejectedValueOnce(
          new ChainGatewayError(
            'another chain',
            200,
            'wrong_network',
            '/v1/ratings'
          )
        )
    ];
    for (const setUp of failing) {
      setUp();
      const report = await mirror.run({ budgetMs: 60_000 });
      expect(report.error).toBeUndefined();
      expect(report.failed).toEqual([]);
      expect(db.state?.next_height).toBe(101);
      expect(db.state?.retry).toEqual(NOTHING_TO_RETRY);
    }
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(102);
  });

  it('writes the other raters of a target, removals too, when one cannot be named yet', async () => {
    const { mirror, db, chain, alice } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    // Made at 20; the bindings have followed only to 1: not named yet.
    const late = chainIdentity(PID(60), [W(60)], {
      legacyId: null,
      founder: W(60),
      createdHeight: 20
    });
    chain.identities.set(late.principalId, late);
    db.placeholders.set(W(60), 'p-late');
    const row = (rater: string, category: string, rating: number) => ({
      rater_profile_id: rater,
      matter: 'REP' as const,
      matter_category: category,
      rating
    });
    // Its row, under an id it could get, stays; another rater's old row
    // that the chain no longer has goes.
    const its = row('p-late', 'Late', 3);
    const stale = row('p-old', 'Old', 4);
    db.ratings.set(ALICE_PROFILE, [its, stale]);
    chain.ratings.set(alice.principalId, [
      ...(chain.ratings.get(alice.principalId) ?? []),
      {
        rater: late.principalId,
        target: alice.principalId,
        matter: 'rep',
        category: { id: '0x04', name: 'Late' },
        value: '3',
        updatedHeight: 40,
        viaGrant: null
      }
    ]);
    db.state = {
      ...db.state!,
      retry: { principals: [], targets: [alice.principalId], wallets: [] }
    };
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.failed).toEqual([]);
    const rows = db.ratings.get(ALICE_PROFILE) ?? [];
    expect(rows).toContainEqual(its);
    expect(rows).not.toContainEqual(stale);
    expect(rows.map((it) => it.matter_category)).toContain('Kind');
    expect(db.state?.retry.targets).toEqual([alice.principalId]);
    expect(db.mapping.has(late.principalId)).toBe(false);
  });

  it('wipes nothing for one answer from another network', async () => {
    const { mirror, db, chain, gateway } = world();
    chain.network = '0xaa';
    await mirror.run({ budgetMs: 60_000 });
    db.mapping.set(PID(98), { profile: 'made-on-this-chain', origin: 'NEW' });
    gateway.getHead.mockImplementationOnce(async () => ({
      headHeight: 102,
      finalizedHeight: 100,
      finalizedTime: 0,
      pinnable: null,
      network: '0xbb'
    }));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.skipped).toBe('network_unsettled');
    expect(db.state?.chain_id).toBe('0xaa');
    expect(db.mapping.has(PID(98))).toBe(true);
    expect(db.state?.next_height).toBe(101);
  });

  it('returns what it regrouped with the error when a run stops part way', async () => {
    const { mirror, db, chain, alice, bob } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.identities.set(alice.principalId, { ...alice, wallets: [A, B, C] });
    chain.identities.delete(bob.principalId);
    chain.feed.push(
      {
        from: 101,
        through: 101,
        next: 102,
        blocks: [
          block(101, [
            {
              family: '0x0102',
              name: 'AddressBinding',
              key: '0x',
              value: null,
              keyFields: { address: C },
              valueFields: { principalId: alice.principalId }
            }
          ])
        ]
      },
      { from: 102, through: 102, next: 103, blocks: [block(102, [])] }
    );
    chain.finalized = 102;
    jest
      .spyOn(db, 'saveState')
      .mockImplementation(async (state: MirrorState) => {
        if (state.next_height === 103) throw new Error('lost connection');
        db.state = state;
      });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBe('lost connection');
    expect(report.regroupedWallets).toEqual(expect.arrayContaining([C]));
    expect(db.state?.next_height).toBe(102);
  });

  const principalRecord = (principal: string) => ({
    family: '0x0201',
    name: 'Principal',
    key: '0x',
    value: null,
    keyFields: { principal }
  });

  it('follows the feed during a full sync, and the sync never sends it back', async () => {
    const { mirror, db, chain, alice } = world();
    await mirror.run({ budgetMs: 60_000 });
    // A full sync under way since 100; the feed has news at 105.
    db.state = {
      ...db.state!,
      sync_phase: 'IDENTITIES',
      sync_from_height: 100,
      sync_after: null
    };
    chain.identities.set(alice.principalId, { ...alice, handle: 'alice2' });
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [block(105, [principalRecord(alice.principalId)])]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.mode).toBe('full_sync');
    expect(report.feedBlocks).toBe(1);
    expect(db.state?.sync_phase).toBeNull();
    expect(db.state?.next_height).toBe(106);
  });

  it('starts the feed from the first full sync height before the sync ends', async () => {
    const { mirror, db, gateway } = world();
    gateway.listIdentities.mockRejectedValueOnce(new Error('timeout'));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBe('timeout');
    expect(db.state?.sync_phase).toBe('IDENTITIES');
    expect(db.state?.next_height).toBe(101);
  });

  it('never pins a read below one the run already used', async () => {
    const { mirror, db, chain, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      sync_phase: 'IDENTITIES',
      sync_from_height: 100,
      sync_after: null
    };
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [block(105, [])]
    });
    // Once the page at 105 is read, another node answers the status: 100.
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        if (String(from) === '106' && !opts?.families) chain.headHeldAt = 100;
        return await changesOf(from, opts);
      }
    );
    gateway.listIdentities.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(106);
    // The full sync waits for a head at 105 or past it.
    expect(gateway.listIdentities).not.toHaveBeenCalled();
    expect(db.state?.sync_phase).toBe('IDENTITIES');
  });

  it("reads the head again when the cached one is below a page's end", async () => {
    const { mirror, db, chain, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [block(105, [])]
    });
    const headOf = gateway.getHead.getMockImplementation()!;
    gateway.getHead.mockImplementation(async (force?: boolean) => {
      const head = await headOf();
      return force ? head : { ...head, finalizedHeight: 100 };
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(106);
  });

  it("names a mapped rater from its mapping without reading the rater's identity", async () => {
    const { mirror, db, gateway, alice, bob } = world();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.mapping.has(bob.principalId)).toBe(true);
    db.state = {
      ...db.state!,
      retry: { principals: [], targets: [alice.principalId], wallets: [] }
    };
    gateway.getIdentityByPrincipal.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(
      gateway.getIdentityByPrincipal.mock.calls.map((it) => it[0])
    ).toEqual([alice.principalId]);
    expect(
      db.ratings.get(ALICE_PROFILE)?.map((it) => it.rater_profile_id)
    ).toEqual([db.mapping.get(bob.principalId)?.profile]);
  });

  it('keeps the pairs of identities it does not write', async () => {
    const { mirror, db, chain } = world();
    const closing = chainIdentity(PID(70), [W(70), W(71)], {
      status: 'closing'
    });
    chain.identities.set(closing.principalId, closing);
    db.keyWidth = 200;
    const wide = chainIdentity(
      PID(72),
      [W(72), W(73), W(74), W(75), W(76)],
      {}
    );
    chain.identities.set(wide.principalId, wide);
    // The closing identity's pairs are as they were before it closed.
    db.pairs = [
      { wallet1: W(70), wallet2: W(77) },
      { wallet1: W(72), wallet2: W(73) },
      { wallet1: W(80), wallet2: W(81) }
    ];
    await mirror.run({ budgetMs: 60_000 });
    expect(db.pairs).toEqual(
      expect.arrayContaining([
        { wallet1: W(70), wallet2: W(77) },
        { wallet1: W(72), wallet2: W(73) }
      ])
    );
    expect(db.pairs).not.toContainEqual({ wallet1: W(70), wallet2: W(71) });
    // A pair no identity holds goes.
    expect(db.pairs).not.toContainEqual({ wallet1: W(80), wallet2: W(81) });
    expect(db.pairs.filter((it) => it.wallet1 === W(72))).toHaveLength(1);
  });

  const leveled = (
    identity: ChainIdentity,
    raw: number,
    tdhDay: number
  ): ChainIdentity => ({
    ...identity,
    level: {
      level: 1,
      raw: String(raw),
      rep: '0',
      tdh: String(raw),
      tdhDay
    }
  });

  it('sweeps the levels after a TDH day, writing only level_raw of mapped identities', async () => {
    const { mirror, db, chain, alice, bob, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    // Day 25 was seen on the first run's reads: the next run sweeps it.
    expect(db.state?.levels_tdh_day).toBe(25);
    expect(db.state?.level_sweep_day).toBe(25);
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBeNull();
    db.levelWrites = [];
    gateway.getLevelRanking.mockClear();
    // Day 26: the levels move; nothing on the feed says so.
    chain.identities.set(alice.principalId, leveled(alice, 2000, 26));
    chain.identities.set(bob.principalId, leveled(bob, 700, 26));
    const unmapped = leveled(chainIdentity(PID(50), [W(50)]), 900, 26);
    chain.identities.set(unmapped.principalId, unmapped);
    // A later read of one identity (here, for its ratings) shows the day.
    db.state = {
      ...db.state!,
      retry: { principals: [], targets: [alice.principalId], wallets: [] }
    };
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.levels_tdh_day).toBe(26);
    expect(first.levelSweepDay).toBe(26);
    // The next run sweeps it.
    const second = await mirror.run({ budgetMs: 60_000 });
    expect(second.levelSweepDay).toBeNull();
    expect(db.state?.level_sweep_day).toBeNull();
    const bobProfile = db.mapping.get(bob.principalId)!.profile;
    expect(db.levelWrites).toEqual([
      [
        { profile_id: ALICE_PROFILE, level_raw: 2000 },
        { profile_id: bobProfile, level_raw: 700 }
      ]
    ]);
    expect(
      Array.from(db.rows.values()).find((it) => it.profile_id === bobProfile)
        ?.level_raw
    ).toBe(700);
    expect(db.mapping.has(unmapped.principalId)).toBe(false);
    expect(second.levelsWritten).toBe(2);
  });

  it('goes on with a level sweep across runs, a page at a time, and starts again for a newer day', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    for (let i = 0; i < 4; i++) {
      const it = leveled(chainIdentity(PID(80 + i), [W(80 + i)]), 100 - i, 25);
      chain.identities.set(it.principalId, it);
    }
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      level_sweep_day: 26,
      level_sweep_after: null,
      levels_tdh_day: 26
    };
    // One page of 500 holds them all: a page fits in each run's share.
    gateway.getLevelRanking.mockClear();
    let pages = 0;
    const rank = gateway.getLevelRanking.getMockImplementation()!;
    gateway.getLevelRanking.mockImplementation(async (opts) => {
      pages++;
      tick(20_000);
      return await rank({ ...opts, limit: 2 });
    });
    await mirror.run({ budgetMs: 60_000 });
    // A quarter of the run's minute for the sweep: one 20 s page.
    expect(pages).toBe(1);
    expect(db.state?.level_sweep_day).toBe(26);
    expect(db.state?.level_sweep_after).not.toBeNull();
    const after = db.state?.level_sweep_after;
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getLevelRanking.mock.calls[1][0]).toMatchObject({ after });
    // A newer day while one is under way starts again from the top.
    db.state = { ...db.state!, level_sweep_day: 26, level_sweep_after: 'x' };
    chain.identities.set(
      PID(80),
      leveled(chain.identities.get(PID(80))!, 99, 27)
    );
    db.state = {
      ...db.state!,
      retry: { principals: [PID(80)], targets: [], wallets: [] }
    };
    gateway.getLevelRanking.mockImplementation(async () => {
      throw new Error('not reached');
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.levelSweepProblem).toBe('not reached');
    expect(db.state).toMatchObject({
      levels_tdh_day: 27,
      level_sweep_day: 27,
      level_sweep_after: null
    });
  });

  it('starts no level sweep without a newer TDH day', async () => {
    const { mirror, db, gateway, alice } = world();
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    gateway.getLevelRanking.mockClear();
    // Alice is read again, still on day 25.
    db.state = {
      ...db.state!,
      retry: { principals: [alice.principalId], targets: [], wallets: [] }
    };
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledWith(
      alice.principalId,
      expect.anything()
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getLevelRanking).not.toHaveBeenCalled();
    expect(db.state?.levels_tdh_day).toBe(25);
  });

  it("says when the gateway's node isn't ready, and reads on", async () => {
    const { mirror, db, chain, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    const headOf = gateway.getHead.getMockImplementation()!;
    gateway.getHead.mockImplementation(async () => ({
      ...(await headOf()),
      ready: false,
      notReady: 'head 20 slots behind'
    }));
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [block(101, [])]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.gatewayNotReady).toBe('head 20 slots behind');
    expect(db.state?.next_height).toBe(102);
  });

  it('ends the run without moving on at a feed page of another chain', async () => {
    const { mirror, db, chain, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [block(101, [])]
    });
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        if (String(from) === '101' && !opts?.families) {
          throw new ChainGatewayError(
            'another chain',
            200,
            'wrong_network',
            '/v1/feed'
          );
        }
        return await changesOf(from, opts);
      }
    );
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBeUndefined();
    expect(db.state?.next_height).toBe(101);
  });

  it('starts the keys to retry again with a full sync', async () => {
    const { mirror, db, gateway, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      retry: { principals: [PID(77)], targets: [], wallets: [] }
    };
    tick(6 * 60 * 60 * 1000 + 1);
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.mode).toBe('full_sync');
    expect(gateway.getIdentityByPrincipal).not.toHaveBeenCalledWith(PID(77));
    expect(db.state?.retry).toEqual(NOTHING_TO_RETRY);
  });

  it('stops reading bindings at a page that does not move on', async () => {
    const { mirror, db, chain, gateway } = world();
    chain.importStart = 1;
    gateway.getChanges.mockImplementation(
      async (from: string | number, opts: { families?: string[] } = {}) =>
        opts.families
          ? {
              from,
              through: 0,
              next: '1:5',
              nextHeight: 1,
              atHead: false,
              blocks: [
                {
                  height: 1,
                  slot: 0,
                  root: '0x',
                  time: 0,
                  complete: false,
                  records: []
                }
              ]
            }
          : {
              from,
              through: 100,
              blocks: [],
              next: 101,
              nextHeight: 101,
              atHead: true
            }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.bindings_next_height).toBe(1);
  });

  it('halves the page when the gateway says the answer is too large', async () => {
    const { mirror, db, chain, gateway, alice } = world();
    chain.importStart = 1;
    chain.feed.push({
      from: 1,
      through: 10,
      next: 11,
      blocks: [block(2, [bind(A, alice.principalId)])]
    });
    gateway.getChanges.mockRejectedValueOnce(
      new ChainGatewayError('too large', 413, 'too_large', '/v1/feed')
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getChanges).toHaveBeenNthCalledWith(1, 1, {
      limit: 200,
      families: ['0x0102']
    });
    expect(gateway.getChanges).toHaveBeenNthCalledWith(2, 1, {
      limit: 100,
      families: ['0x0102']
    });
    expect(db.bindings.get(A)?.bound_from_height).toBe(2);
  });

  it('lists the placeholder profiles once, before any write', async () => {
    const { mirror, db } = world();
    const before = '00000000-0000-4000-8000-00000000aaaa';
    db.profiles.set(before, {
      external_id: before,
      handle: `id-${W(80)}`,
      normalised_handle: `id-${W(80)}`,
      primary_wallet: W(80),
      pfp_url: null,
      banner_1: null,
      banner_2: null,
      website: null,
      classification: null,
      sub_classification: null
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.placeholders_at).toBe(1_000);
    expect(db.placeholders.get(W(80))).toBe(before);
    // A profile made later with a placeholder handle is not listed.
    db.profiles.set('later', {
      ...db.profiles.get(before)!,
      external_id: 'later',
      handle: `id-${W(81)}`,
      normalised_handle: `id-${W(81)}`,
      primary_wallet: W(81)
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.placeholders.has(W(81))).toBe(false);
  });

  it("gives an identity made on the chain its founding wallet's placeholder profile", async () => {
    const { mirror, db, chain } = world();
    chain.importStart = 1;
    const founder = W(40);
    const placeholder = '00000000-0000-4000-8000-00000000f00d';
    db.profiles.set(placeholder, {
      external_id: placeholder,
      handle: `id-${founder}`,
      normalised_handle: `id-${founder}`,
      primary_wallet: founder,
      pfp_url: null,
      banner_1: null,
      banner_2: null,
      website: null,
      classification: null,
      sub_classification: null
    });
    const made = chainIdentity(PID(40), [founder, W(41)], {
      legacyId: null
    });
    // Its second wallet had a placeholder too: left without wallets.
    const other = '00000000-0000-4000-8000-00000000beef';
    db.rows.set(W(41), {
      consolidation_key: W(41),
      profile_id: other,
      primary_address: W(41),
      handle: `id-${W(41)}`,
      normalised_handle: `id-${W(41)}`,
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
      basetdh_rate: 0
    });
    db.addressKeys.set(W(41), W(41));
    // Its founder bound to it at its creation (3), as the bindings follow it.
    chain.feed.push({
      from: 1,
      through: 5,
      next: 6,
      blocks: [block(3, [bind(founder, made.principalId)])]
    });
    chain.identities.set(made.principalId, made);
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(db.mapping.get(made.principalId)).toEqual({
      profile: placeholder,
      origin: 'FOUNDER'
    });
    expect(report.orphanedProfiles).toEqual([other]);
    // A rebuild from the chain maps it the same way, even after the
    // profile took a handle.
    db.profiles.set(placeholder, {
      ...db.profiles.get(placeholder)!,
      handle: 'carol',
      normalised_handle: 'carol'
    });
    db.mapping.delete(made.principalId);
    expect(await mirror.profileIdOf(made)).toBe(placeholder);
  });

  it('takes the founder the gateway names over the anchor, and not an imported profile', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(90), 'p-founder');
    db.placeholders.set(W(91), 'p-anchor');
    const made = chainIdentity(PID(90), [W(91), W(90)], {
      legacyId: null,
      anchor: W(91),
      founder: W(90)
    });
    // The founder's history: bound to this identity at its creation, first.
    chain.identities.set(made.principalId, made);
    expect(await mirror.profileIdOf(made)).toBe('p-founder');
    db.placeholders.set(W(92), 'p-imported');
    gateway.getIdentityByLegacyProfileId.mockImplementation(
      async (id: string) =>
        id === 'p-imported' ? (chainIdentity(PID(1), [A]) as never) : null
    );
    const other = chainIdentity(PID(92), [W(92)], {
      legacyId: null,
      founder: W(92)
    });
    // Bound to it from its creation, but the import took the placeholder.
    chain.identities.set(other.principalId, other);
    expect(await mirror.profileIdOf(other)).toBe(principalProfileId(PID(92)));
    expect(gateway.getIdentityByLegacyProfileId).toHaveBeenCalledWith(
      'p-imported'
    );
  });

  it('files a merged identity made on the chain under its founder placeholder on a rebuild', async () => {
    const { mirror, db, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(61), 'p-founder');
    const made = chainIdentity(PID(61), [W(61)], {
      legacyId: null,
      founder: W(61)
    });
    chain.identities.set(made.principalId, made);
    expect(await mirror.profileIdOf(made)).toBe('p-founder');
    // Merged later; a rebuild starts with no mappings.
    const merged = { ...made, wallets: [], mergedInto: PID(1) };
    db.mapping.clear();
    expect(await mirror.profileIdForSites(merged)).toEqual({
      profileId: 'p-founder',
      imported: false
    });
    expect(db.mapping.size).toBe(0);
  });

  it('files a merged identity for the profile site index without mapping it', async () => {
    const { mirror, db } = world();
    const merged = chainIdentity(PID(60), [], {
      legacyId: null,
      mergedInto: PID(1)
    });
    expect(await mirror.profileIdForSites(merged)).toEqual({
      profileId: principalProfileId(PID(60)),
      imported: false
    });
    expect(db.mapping.has(PID(60))).toBe(false);
  });

  it('stores no binding for a listed wallet bound to no one', async () => {
    const { mirror, db, gateway, chain } = world();
    gateway.listMembershipWallets.mockImplementationOnce(async () => ({
      items: [
        { wallet: A, principalId: PID(1) },
        { wallet: W(70), principalId: null as unknown as string }
      ],
      next: null,
      read: { height: chain.finalized } as never
    }));
    await mirror.run({ budgetMs: 60_000 });
    expect(db.bindings.has(A)).toBe(true);
    expect(db.bindings.has(W(70))).toBe(false);
  });

  it('takes the anchor as founder only when it was bound at the creation', async () => {
    const { mirror, db, gateway } = world();
    db.placeholders.set(W(93), 'p-anchor');
    const later = chainIdentity(PID(93), [W(93)], {
      legacyId: null,
      createdHeight: 5
    });
    gateway.getMembershipWallet.mockResolvedValueOnce({
      wallet: W(93),
      principalId: PID(93),
      firstBoundHeight: 9
    } as never);
    expect(await mirror.profileIdOf(later)).toBe(principalProfileId(PID(93)));
  });

  it("gives a wallet's placeholder to the first identity it made", async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(94), 'p-first');
    // W(94) made PID(94) at 3, left, and made PID(95) at 20.
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(94),
      changes: [
        { height: 3, principalId: PID(94) },
        { height: 10, principalId: null },
        { height: 20, principalId: PID(95) }
      ],
      ranges: [[1, 100]],
      readHeight: 100
    } as never);
    const second = chainIdentity(PID(95), [W(94)], {
      legacyId: null,
      founder: W(94),
      createdHeight: 20
    });
    expect(await mirror.profileIdOf(second)).toBe(principalProfileId(PID(95)));
    const first = chainIdentity(PID(94), [W(96)], {
      legacyId: null,
      founder: W(94),
      createdHeight: 3
    });
    expect(await mirror.profileIdOf(first)).toBe('p-first');
  });

  it('names a merged rater without mapping it', async () => {
    const { mirror, db, chain, alice } = world();
    const merged = chainIdentity(PID(97), [], {
      legacyId: null,
      mergedInto: alice.principalId
    });
    chain.identities.set(merged.principalId, merged);
    chain.ratings.set(alice.principalId, [
      ...(chain.ratings.get(alice.principalId) ?? []),
      {
        rater: merged.principalId,
        target: alice.principalId,
        matter: 'rep',
        category: { id: '0x03', name: 'Old' },
        value: '2',
        updatedHeight: 31,
        viaGrant: null
      }
    ]);
    await mirror.run({ budgetMs: 60_000 });
    expect(db.mapping.has(merged.principalId)).toBe(false);
    expect(
      db.ratings.get(ALICE_PROFILE)?.map((it) => it.rater_profile_id)
    ).toContain(principalProfileId(PID(97)));
  });

  it('asks the import for a legacy id the gateway leaves out', async () => {
    const { mirror, gateway } = world();
    const old = chainIdentity(PID(50), [W(50)]);
    gateway.getImportedIdentity.mockResolvedValueOnce({
      principalId: PID(50),
      legacyId: '00000000-0000-4000-8000-0000000000aa'
    } as never);
    expect(await mirror.profileIdOf(old)).toBe(
      '00000000-0000-4000-8000-0000000000aa'
    );
    const made = chainIdentity(PID(51), [W(51)], { legacyId: null });
    expect(await mirror.profileIdOf(made)).toBe(principalProfileId(PID(51)));
    // The import's end isn't known yet (no run), so a null is confirmed too.
    expect(gateway.getImportedIdentity).toHaveBeenCalledTimes(2);
  });

  it("takes no help-bot credit from the chain's ratings", async () => {
    const { mirror, db, chain, alice, bob } = world();
    chain.ratings.set(alice.principalId, [
      ...(chain.ratings.get(alice.principalId) ?? []),
      {
        rater: bob.principalId,
        target: alice.principalId,
        matter: 'rep',
        category: { id: '0x02', name: 'help6529 credits ' },
        value: '9',
        updatedHeight: 31,
        viaGrant: null
      }
    ]);
    await mirror.run({ budgetMs: 60_000 });
    expect(
      db.ratings.get(ALICE_PROFILE)?.map((it) => it.matter_category)
    ).toEqual(['Kind']);
  });

  it('reports a bindings failure and goes on with the identities', async () => {
    const { mirror, db, gateway } = world();
    gateway.listMembershipWallets.mockRejectedValueOnce(
      new Error('membership read failed')
    );
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.bindingProblems).toEqual(['membership read failed']);
    expect(report.bindingsNextHeight).toBeNull();
    expect(db.state?.next_height).toBe(101);
  });

  it('keeps the cursor when writing the rows fails', async () => {
    const { mirror, db, chain, alice } = world();
    chain.importStart = 1;
    chain.feed.push({
      from: 1,
      through: 10,
      next: 11,
      blocks: [block(2, [bind(A, alice.principalId)])]
    });
    const write = jest
      .spyOn(db, 'writeWalletBindings')
      .mockRejectedValueOnce(new Error('deadlock'));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.bindingProblems).toEqual(['deadlock']);
    expect(db.state?.bindings_next_height).toBe(1);
    write.mockRestore();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.bindings_next_height).toBe(11);
    expect(db.bindings.get(A)?.bound_from_height).toBe(2);
  });

  it('refuses a membership list page read at another height', async () => {
    const { mirror, db, gateway, chain } = world();
    gateway.listMembershipWallets.mockImplementationOnce(async () => ({
      items: [{ wallet: A, principalId: PID(1) }],
      next: null,
      read: { height: chain.finalized - 5 } as never
    }));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.bindingsNextHeight).toBeNull();
    expect(db.bindings.size).toBe(0);
  });

  it('runs no profile site follower in the middle of a full sync', async () => {
    const calls: unknown[] = [];
    const { mirror, db } = world([
      async (port) => {
        calls.push(port);
      }
    ]);
    await mirror.run({ budgetMs: 60_000 });
    db.state = { ...db.state!, sync_phase: 'DELEGATIONS' };
    expect(await mirror.followProfileSites()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('runs the profile site followers when asked, after a full sync', async () => {
    const seen: unknown[] = [];
    const ok: ProfileSiteFollower = async (port) => {
      seen.push(port);
    };
    const broken: ProfileSiteFollower = async () => {
      throw new Error('site index down');
    };
    const { mirror, chain } = world([ok, broken]);
    chain.importCompleted = true;
    expect(await mirror.followProfileSites()).toEqual([]);
    expect(seen).toHaveLength(0);
    await mirror.run({ budgetMs: 60_000 });
    expect(await mirror.followProfileSites()).toEqual(['site index down']);
    expect(seen).toHaveLength(1);
    expect(typeof (seen[0] as { getChanges: unknown }).getChanges).toBe(
      'function'
    );
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

  it('writes an expiry of 0 as never, and a past one as it is', () => {
    const row = (expiry: string) =>
      toDelegationRow(A, delegation(A, 'wallet', { expiry }))?.expiry;
    expect(row('0')).toBe(NEVER_EXPIRES);
    expect(row('1')).toBe(1);
    expect(row('99999999999999999999')).toBe(NEVER_EXPIRES);
    expect(row('not a number')).toBe(NEVER_EXPIRES);
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
    // Tried once a run: the next run tries it again.
    expect(report.failed).toEqual([`${bob.principalId}: duplicate`]);
    expect(db.state?.sync_phase).toBeNull();
    expect(db.rows.size).toBeGreaterThan(0);
    expect(db.state?.retry).toEqual({
      principals: [bob.principalId],
      targets: [bob.principalId],
      wallets: []
    });
    const next = await mirror.run({ budgetMs: 60_000 });
    expect(next.failed).toEqual([`${bob.principalId}: duplicate`]);
    expect(db.state?.retry.principals).toEqual([bob.principalId]);
    // Its ratings were written: only the identity is left.
    expect(db.state?.retry.targets).toEqual([]);
  });

  it('asks again before giving up on a feed height', async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    gateway.getChanges.mockRejectedValueOnce(
      new ChainGatewayError('gone', 410, 'gone', '/v1/feed')
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.sync_phase).toBeNull();
    // The first run reads the feed once; the second, twice for the bindings
    // (one refused) and once for the identities.
    expect(gateway.getChanges).toHaveBeenCalledTimes(4);
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
