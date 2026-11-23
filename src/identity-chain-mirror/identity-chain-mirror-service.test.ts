import { isHelpBotCreditCategory } from './help-bot-credit-category';
import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import {
  ChainDelegation,
  ChainFeedPage,
  ChainFeedRecord,
  ChainIdentity,
  ChainRating,
  ChainRatingTotal
} from '@/chain-gateway/chain-gateway.types';
import {
  DelegationRowWrite,
  FirstBinding,
  IdentityChainMirrorDb,
  MirrorState,
  RatingEventRow,
  RatingLedgerKey,
  RatingRowWrite
} from './identity-chain-mirror.db';
import { IdentityChainLookups } from './identity-chain-lookups';
import { MembershipChange } from './membership-change';
import { ProfileSiteFollower } from './profile-site-port';
import { WalletBindingRow } from './wallet-bindings';
import {
  CHAIN_DELEGATION_USE_CASES,
  feedEffects,
  IdentityChainMirror,
  RELAUNCH_ALLOWED_ENV,
  toDelegationRow
} from './identity-chain-mirror.service';
import { FOUNDER_WAIT_MS, ProfileIds } from './profile-ids';
import { ledgerKeyOf, totalKeyOf } from './rating-events';
import type {
  RatingEventsCursor,
  RatingLedgerRow
} from './identity-chain-mirror.db';
import {
  RATING_EVENTS_MAPPED_A_PAGE,
  RATING_EVENTS_STUCK_RUNS,
  RatingEventsFollower,
  RatingEventsReport
} from './rating-events-follower';
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
  ratingReads: { target: string }[] = [];
  ratingEvents: (RatingEventRow & { created_at: number })[] = [];
  ledger = new Map<string, RatingLedgerRow>();
  categoryNames = new Map<string, string>();
  async insertRatingEvents(rows: RatingEventRow[], now: number) {
    let written = 0;
    for (const row of rows) {
      const key = (it: RatingEventRow) =>
        JSON.stringify([
          it.height,
          it.rater_principal,
          it.target_principal,
          it.matter,
          it.matter_category
        ]);
      if (this.ratingEvents.some((it) => key(it) === key(row))) continue;
      this.ratingEvents.push({ ...row, created_at: now });
      written++;
    }
    return written;
  }
  async ratingLedgerOf(keys: RatingLedgerKey[]) {
    const result = new Map<string, RatingLedgerRow>();
    keys.forEach((it) => {
      const row = this.ledger.get(ledgerKeyOf(it));
      if (row) result.set(ledgerKeyOf(it), row);
    });
    return result;
  }
  async ratingLedgerTotalsOf(
    keys: {
      targetKind: number;
      target: string;
      matterCode: number;
      category: string;
    }[]
  ) {
    const result = new Map<string, { total: number; stale: number }>();
    for (const key of keys) {
      let total = 0;
      let stale = 0;
      let any = false;
      this.ledger.forEach((row, k) => {
        const [, matter, kind, target, category] = JSON.parse(k);
        if (
          matter === key.matterCode &&
          kind === key.targetKind &&
          target === key.target &&
          category === key.category
        ) {
          total += row.value;
          stale += row.stale ? 1 : 0;
          any = true;
        }
      });
      if (any) result.set(totalKeyOf(key), { total, stale });
    }
    return result;
  }
  async writeRatingLedger(
    upserts: (RatingLedgerKey & RatingLedgerRow)[],
    deletes: RatingLedgerKey[]
  ) {
    upserts.forEach((it) =>
      this.ledger.set(ledgerKeyOf(it), {
        value: it.value,
        height: it.height,
        stale: it.stale
      })
    );
    deletes.forEach((it) => this.ledger.delete(ledgerKeyOf(it)));
  }
  async clearRatingEvents() {
    this.ledger.clear();
    this.ratingEvents = [];
    this.categoryNames.clear();
    if (this.state) {
      this.state = {
        ...this.state,
        events_next_height: null,
        events_rebuild_height: null,
        events_rebuild_after: null,
        events_gone_at: null,
        events_stuck_runs: 0
      };
    }
  }
  async clearRatingLedger() {
    this.ledger.clear();
  }
  async saveRatingEventsCursor(cursor: RatingEventsCursor) {
    if (!this.state) return;
    this.state = {
      ...this.state,
      events_next_height: cursor.next,
      events_rebuild_height: cursor.rebuildHeight,
      events_rebuild_after: cursor.rebuildAfter,
      events_gone_at: cursor.goneAt,
      events_stuck_runs: cursor.stuckRuns
    };
  }
  async ratingCategoryNamesOf(ids: string[]) {
    return new Map(
      ids.flatMap((id) => {
        const name = this.categoryNames.get(id);
        return name === undefined ? [] : [[id, name] as [string, string]];
      })
    );
  }
  async writeRatingCategories(names: { id: string; name: string }[]) {
    names.forEach((it) => {
      if (!this.categoryNames.has(it.id))
        this.categoryNames.set(it.id, it.name);
    });
  }
  async fillRatingEventProfiles(createdSince: number) {
    let filled = 0;
    this.ratingEvents = this.ratingEvents.map((it) => {
      if (it.created_at < createdSince) return it;
      const rater =
        it.rater_profile_id ??
        this.mapping.get(it.rater_principal)?.profile ??
        null;
      const target =
        it.target_profile_id ??
        this.mapping.get(it.target_principal)?.profile ??
        null;
      if (rater === it.rater_profile_id && target === it.target_profile_id) {
        return it;
      }
      filled++;
      return { ...it, rater_profile_id: rater, target_profile_id: target };
    });
    // The whole window in one pass (the chunks are the SQL's: db tests).
    return { filled, after: null };
  }
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
  levelHeights = new Map<string, number>();
  founderWaits = new Map<string, number>();
  async writeLevels(
    levels: { profile_id: string; level_raw: number }[],
    height: number
  ) {
    this.levelWrites.push(levels);
    let written = 0;
    for (const it of levels) {
      const principal = Array.from(this.mapping.entries()).find(
        ([, m]) => m.profile === it.profile_id
      )?.[0];
      if (!principal) continue;
      if ((this.levelHeights.get(principal) ?? -1) > height) continue;
      for (const [key, row] of Array.from(this.rows.entries())) {
        if (row.profile_id === it.profile_id) {
          this.rows.set(key, { ...row, level_raw: it.level_raw });
          this.levelHeights.set(principal, height);
          written++;
        }
      }
    }
    return written;
  }
  fixes: { repToo: boolean; leaveOut: readonly string[] }[] = [];
  async fixRowsOffTheChain({
    repToo = true,
    leaveOut = []
  }: { repToo?: boolean; leaveOut?: readonly string[] } = {}) {
    this.fixes.push({ repToo, leaveOut });
    const mapped = new Set(
      Array.from(this.mapping.values()).map((it) => it.profile)
    );
    const fixed = { rep: 0, level: 0 };
    for (const [key, row] of Array.from(this.rows.entries())) {
      if (row.profile_id === null || mapped.has(row.profile_id)) continue;
      if (leaveOut.includes(row.profile_id)) continue;
      const ratings = (this.ratings.get(row.profile_id) ?? []).filter(
        (it) => it.matter === 'REP'
      );
      let rep = row.rep;
      if (
        repToo &&
        ratings.some((it) => isHelpBotCreditCategory(it.matter_category))
      ) {
        rep = ratings
          .filter((it) => !isHelpBotCreditCategory(it.matter_category))
          .reduce((sum, it) => sum + it.rating, 0);
        if (rep !== row.rep) fixed.rep++;
      }
      const level = rep + row.tdh;
      if (level !== row.level_raw) fixed.level++;
      this.rows.set(key, { ...row, rep, level_raw: level });
    }
    return fixed;
  }
  async clearLevelHeights() {
    this.levelHeights.clear();
  }
  async levelHeightOf(principal: string) {
    return this.levelHeights.get(principal.toLowerCase()) ?? null;
  }
  async setLevelHeight(principal: string, height: number) {
    const key = principal.toLowerCase();
    if ((this.levelHeights.get(key) ?? -1) < height) {
      this.levelHeights.set(key, height);
    }
  }
  async founderWaitSince(principal: string, now: number) {
    if (!this.founderWaits.has(principal)) {
      this.founderWaits.set(principal, now);
    }
    return this.founderWaits.get(principal)!;
  }
  async founderWaitDone(principal: string) {
    this.founderWaits.delete(principal);
    this.founderDecisions.delete(principal);
  }
  founderDecisions = new Map<string, string>();
  async founderDecisionOf(principal: string) {
    return this.founderDecisions.get(principal.toLowerCase()) ?? null;
  }
  async founderDecided(principal: string, profileId: string) {
    this.founderDecisions.set(principal.toLowerCase(), profileId);
  }
  levelSteps: { after: string; leaveOut: readonly string[] }[] = [];
  async fixLevelsOffTheChain({
    after,
    leaveOut = []
  }: {
    after: string;
    chunks: number;
    leaveOut?: readonly string[];
  }) {
    this.levelSteps.push({ after, leaveOut });
    const fixed = await this.fixRowsOffTheChain({ repToo: false, leaveOut });
    this.fixes.pop();
    return { level: fixed.level, after: null };
  }
  outsideDeleted: number[][] = [];
  async deleteDelegationsOutside(useCases: number[]) {
    this.outsideDeleted.push(useCases);
    for (const [wallet, rows] of Array.from(this.delegations.entries())) {
      this.delegations.set(
        wallet,
        rows.filter((it) => useCases.includes(it.use_case))
      );
    }
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
    // The rating events follower's columns are its own (saveRatingEventsCursor).
    this.state = {
      ...state,
      events_next_height: this.state?.events_next_height ?? null,
      events_rebuild_height: this.state?.events_rebuild_height ?? null,
      events_rebuild_after: this.state?.events_rebuild_after ?? null,
      events_gone_at: this.state?.events_gone_at ?? null,
      events_stuck_runs: this.state?.events_stuck_runs ?? 0
    };
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
    this.ratingReads.push({ target });
    return { inserted: rows.length, updated: 0, deleted: 0 };
  }
  async replaceWalletDelegations(
    wallet: string,
    rows: DelegationRowWrite[],
    _conn?: unknown,
    useCase?: number
  ) {
    const others =
      useCase === undefined
        ? []
        : (this.delegations.get(wallet) ?? []).filter(
            (it) => it.use_case !== useCase
          );
    this.delegations.set(wallet, [...others, ...rows]);
    return { written: rows.length, deleted: 0 };
  }
  async walletsWithDelegations(_conn?: unknown, useCase?: number) {
    return Array.from(this.delegations.entries())
      .filter(
        ([, rows]) =>
          useCase === undefined || rows.some((it) => it.use_case === useCase)
      )
      .map(([wallet]) => wallet);
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

afterEach(() => {
  delete process.env[RELAUNCH_ALLOWED_ENV];
});

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
    finalized: 100,
    tdhDay: 25,
    categories: new Map<string, string>()
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
    getState: jest.fn(async (key: string) => {
      const name = chain.categories.get(`0x${key.slice(6)}`);
      return name === undefined
        ? null
        : { family: '0x0705', valueFields: { name, createdHeight: 1 } };
    }),
    getStatus: jest.fn(async () => ({ feed: [[1, 1_000_000]] })),
    getRatingTotals: jest.fn(async () => [] as ChainRatingTotal[]),
    getTdh: jest.fn(async () => ({
      read: { height: chain.finalized } as never,
      data: { day: chain.tdhDay },
      next: null
    })),
    getLevel: jest.fn(
      async (p: string) => chain.identities.get(p)?.level ?? null
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
    // A full sync writes no rating events.
    expect(db.ratingReads.map((it) => it.target)).toContain(ALICE_PROFILE);
    expect(db.ratingEvents).toEqual([]);
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

  const CATEGORY = '0x' + '0c'.repeat(32);
  const OTHER = '0x' + '0d'.repeat(32);
  const CREDITS = '0x' + 'cc'.repeat(32);
  /** A REP rating's state key, as the feed gives it. */
  const ratingKey = (rater: string, target: string, category = CATEGORY) =>
    '0x070101' + [rater, target, category].map((it) => it.slice(2)).join('');
  const gone = (path: string) =>
    new ChainGatewayError('gone', 410, 'height_gone', path);
  const down = (path: string) =>
    new ChainGatewayError('down', 503, 'unavailable', path);
  const ratingRecord = (
    rater: string,
    target: string,
    value: number | null,
    writer: ChainFeedRecord['writer'],
    category = CATEGORY,
    byImport: boolean | null = false
  ): ChainFeedRecord => ({
    family: '0x0701',
    name: 'Rating',
    key: ratingKey(rater, target, category),
    value: value === null ? null : '0x01',
    keyFields: { rater, matter: 1, targetKind: 1, target, category },
    valueFields:
      value === null
        ? null
        : { value, updatedHeight: 1, viaGrant: null, index: 0 },
    byImport,
    writer
  });
  const totalRecord = (target: string, sum: number, category = CATEGORY) => ({
    family: '0x0704',
    name: 'RatingTotal',
    key: '0x',
    value: '0x01',
    keyFields: { targetKind: 1, target, matter: 1, category },
    valueFields: { sum: String(sum), raters: 1 }
  });
  const categoryRecord = (id: string, name: string) => ({
    family: '0x0705',
    name: 'Category',
    key: '0x',
    value: '0x01',
    keyFields: { categoryId: id },
    valueFields: { name, createdHeight: 1 }
  });
  const ratingSet = {
    kind: 'tx' as const,
    txId: '0x' + '11'.repeat(32),
    opType: 0x0701,
    opName: 'RATING_SET'
  };
  const ratingScan = { kind: 'system' as const, step: 'RATING_SCAN' as const };
  const imported = { kind: 'system' as const, step: 'IMPORT' as const };
  const timed = (height: number, records: ChainFeedRecord[]) => ({
    height,
    slot: height,
    root: '0x',
    time: 1_764_000_000_000 + height * 12_000,
    records
  });
  /**
   * A chain whose import (from 50, done at 60) set Bob's Kind rating of
   * Alice to 5, then the feed's pages after it.
   */
  const ratedWorld = () => {
    const w = world();
    // The chain's ratings by height, for reads of a value before ('gone':
    // the gateway no longer holds those heights; 'down': it can't answer).
    const history = new Map<
      string,
      [number, number | null][] | 'gone' | 'down' | 'not yet'
    >();
    const categoryState = w.gateway.getState.getMockImplementation()!;
    // The node serves pinned reads of its last 64 views only, and none
    // above its finalized height.
    const held = async (height: number | undefined, path: string) => {
      if (height === undefined) return;
      const finalized = (await w.gateway.getHead()).finalizedHeight;
      if (height > finalized || height < finalized - 64) {
        const error = gone(path);
        error.read = { finalizedHeight: finalized } as never;
        throw error;
      }
    };
    const listOf = w.gateway.listIdentities.getMockImplementation()!;
    w.gateway.listIdentities.mockImplementation((async (opts: {
      after?: string | null;
      height?: number;
    }) => {
      await held(opts?.height, '/v1/identities');
      return await listOf(opts);
    }) as never);
    const ratingsOf = w.gateway.getRatings.getMockImplementation()!;
    w.gateway.getRatings.mockImplementation((async (
      query: { target: string },
      opts?: { height?: number }
    ) => {
      await held(opts?.height, '/v1/ratings');
      return await ratingsOf(query);
    }) as never);
    w.gateway.getState.mockImplementation((async (
      key: string,
      opts?: { height?: number }
    ) => {
      if (!key.startsWith('0x0701')) return await categoryState(key);
      await held(opts?.height, '/v1/state');
      const known = history.get(key) ?? [];
      if (known === 'gone') throw gone('/v1/state');
      if (known === 'down') throw down('/v1/state');
      if (known === 'not yet') {
        const error = gone('/v1/state');
        error.read = { finalizedHeight: (opts?.height ?? 1) - 1 } as never;
        throw error;
      }
      const at = known
        .filter(([height]) => height <= (opts?.height ?? Infinity))
        .at(-1);
      return at && at[1] !== null
        ? { family: '0x0701', value: '0x01', valueFields: { value: at[1] } }
        : null;
    }) as never);
    w.chain.importStart = 50;
    w.chain.importDone = 60;
    w.chain.feed.push({
      from: 50,
      through: 100,
      next: 101,
      blocks: [
        timed(60, [
          categoryRecord(CATEGORY, 'Kind'),
          ratingRecord(
            w.bob.principalId,
            w.alice.principalId,
            5,
            imported,
            CATEGORY,
            true
          ),
          totalRecord(w.alice.principalId, 5)
        ])
      ]
    });
    return { ...w, history };
  };
  /** A follower that starts cold: no category names in memory. */
  const forgetNames = (mirror: unknown) =>
    (
      mirror as { events: { categoryNames: Map<string, string> } }
    ).events.categoryNames.clear();
  const feedRows = (rows: RatingEventRow[]) =>
    rows
      .filter((it) => it.height > 60)
      .map((it) => [it.height, it.old_rating, it.new_rating, it.total_after]);

  it('writes the import as IMPORT rows, then each page from the ledger', async () => {
    const { mirror, db, chain, alice, bob, gateway } = ratedWorld();
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(db.ratingEvents).toEqual([
      expect.objectContaining({
        height: 60,
        old_rating: 0,
        new_rating: 5,
        total_after: 5,
        origin: 'IMPORT',
        by_import: true,
        writer: 'system:IMPORT',
        // Written after the identity sync mapped both: nothing to fill.
        rater_profile_id: db.mapping.get(bob.principalId)?.profile,
        target_profile_id: ALICE_PROFILE
      })
    ]);
    expect(first.ratingEventsFilled).toBe(0);
    expect(db.state?.events_next_height).toBe(101);
    // Bob rates Alice 7 at 101, then 9 at 102; the chain at the head holds
    // 9, which the identity sync writes to 6529.io's ratings.
    chain.feed.push(
      {
        from: 101,
        through: 101,
        next: 102,
        blocks: [
          timed(101, [
            ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
          ])
        ]
      },
      {
        from: 102,
        through: 102,
        next: 103,
        blocks: [
          timed(102, [
            ratingRecord(bob.principalId, alice.principalId, 9, ratingSet),
            totalRecord(alice.principalId, 9)
          ])
        ]
      }
    );
    chain.ratings.get(alice.principalId)![0] = {
      ...chain.ratings.get(alice.principalId)![0],
      value: '9',
      updatedHeight: 102
    };
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(103);
    expect(db.state?.events_next_height).toBe(103);
    expect(feedRows(db.ratingEvents)).toEqual([
      [101, 5, 7, 7],
      [102, 7, 9, 9]
    ]);
    expect(db.ratingEvents[1]).toMatchObject({
      rater_profile_id: db.mapping.get(bob.principalId)?.profile,
      target_profile_id: ALICE_PROFILE,
      matter: 'REP',
      matter_category: 'Kind',
      origin: 'OPERATION',
      writer: 'tx:RATING_SET'
    });
    expect(report.ratingEvents).toBe(2);
    // The ledger followed the feed from the import: nothing read again.
    expect(db.state?.events_rebuild_height).toBeNull();
    expect(gateway.getRatingTotals).not.toHaveBeenCalled();
    expect(gateway.getState).not.toHaveBeenCalledWith(
      expect.stringMatching(/^0x0701/),
      expect.anything()
    );
    // The category's name is stored for a cold start.
    expect(db.categoryNames.get(CATEGORY)).toBe('Kind');
  });

  it('gives the heights below the import end origin IMPORT, and the end block its writer', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    chain.categories.set(OTHER, 'Other');
    chain.feed[0] = {
      ...chain.feed[0],
      blocks: [
        timed(55, [
          ratingRecord(
            alice.principalId,
            bob.principalId,
            3,
            null,
            CATEGORY,
            null
          )
        ]),
        timed(60, [
          ...chain.feed[0].blocks[0].records,
          // The block the import ended in also runs transactions.
          ratingRecord(alice.principalId, bob.principalId, 4, ratingSet, OTHER),
          ratingRecord(bob.principalId, alice.principalId, 2, null, OTHER, null)
        ])
      ]
    };
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(
      db.ratingEvents.map((it) => [it.height, it.origin, it.writer])
    ).toEqual([
      [55, 'IMPORT', null],
      [60, 'IMPORT', 'system:IMPORT'],
      [60, 'OPERATION', 'tx:RATING_SET'],
      [60, 'UNKNOWN', null]
    ]);
    expect(report.ratingRecordsWithoutWriter).toBe(1);
  });

  it('starts a rating again from 0 after its removal', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push(
      {
        from: 101,
        through: 101,
        next: 102,
        blocks: [
          timed(101, [
            ratingRecord(bob.principalId, alice.principalId, null, ratingSet)
          ])
        ]
      },
      {
        from: 102,
        through: 102,
        next: 103,
        blocks: [
          timed(102, [
            ratingRecord(bob.principalId, alice.principalId, 4, ratingSet)
          ])
        ]
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([
      [101, 5, 0, 0],
      [102, 0, 4, 4]
    ]);
    expect(Array.from(db.ledger.values())).toEqual([
      expect.objectContaining({ value: 4, height: 102 })
    ]);
  });

  it("keeps a later page's row for a second category of the same target", async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.categories.set(OTHER, 'Other');
    chain.feed.push(
      {
        from: 101,
        through: 101,
        next: 102,
        blocks: [
          timed(101, [
            ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
          ])
        ]
      },
      {
        from: 102,
        through: 102,
        next: 103,
        blocks: [
          timed(102, [
            ratingRecord(
              bob.principalId,
              alice.principalId,
              4,
              ratingSet,
              OTHER
            )
          ])
        ]
      }
    );
    const r0 = chain.ratings.get(alice.principalId)![0];
    chain.ratings.set(alice.principalId, [
      { ...r0, value: '7', updatedHeight: 101 },
      {
        ...r0,
        category: { id: OTHER, name: 'Other' },
        value: '4',
        updatedHeight: 102
      }
    ]);
    await mirror.run({ budgetMs: 60_000 });
    expect(
      db.ratingEvents
        .filter((it) => it.height > 60)
        .map((it) => [
          it.height,
          it.matter_category,
          it.old_rating,
          it.new_rating
        ])
    ).toEqual([
      [101, 'Kind', 5, 7],
      [102, 'Other', 0, 4]
    ]);
  });

  it('is not moved by a full sync or a retry that wrote newer ratings first', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    // 6529.io's rows already hold the chain's newest value (12) before the
    // follower reads the pages that set 7 and then 12.
    chain.ratings.get(alice.principalId)![0] = {
      ...chain.ratings.get(alice.principalId)![0],
      value: '12'
    };
    db.state = {
      ...db.state!,
      retry: { principals: [], targets: [alice.principalId], wallets: [] }
    };
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      sync_phase: 'IDENTITIES',
      sync_from_height: 100,
      sync_after: null
    };
    await mirror.run({ budgetMs: 60_000 });
    expect(
      db.ratings.get(ALICE_PROFILE)?.find((it) => it.matter_category === 'Kind')
        ?.rating
    ).toBe(12);
    chain.feed.push({
      from: 101,
      through: 102,
      next: 103,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
        ]),
        timed(102, [
          ratingRecord(bob.principalId, alice.principalId, 12, ratingScan)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([
      [101, 5, 7, 7],
      [102, 7, 12, 12]
    ]);
    expect(db.ratingEvents.map((it) => it.origin)).toEqual([
      'IMPORT',
      'OPERATION',
      'CAP_CUT'
    ]);
  });

  it('keeps the next page from the ledger after a full sync between pages', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.events_next_height).toBe(102);
    // A full sync reads Alice at a newer height, where Bob's rating is 12.
    chain.ratings.get(alice.principalId)![0] = {
      ...chain.ratings.get(alice.principalId)![0],
      value: '12'
    };
    db.state = {
      ...db.state!,
      sync_phase: 'IDENTITIES',
      sync_from_height: 101,
      sync_after: null
    };
    await mirror.run({ budgetMs: 60_000 });
    expect(
      db.ratings.get(ALICE_PROFILE)?.find((it) => it.matter_category === 'Kind')
        ?.rating
    ).toBe(12);
    chain.feed.push({
      from: 102,
      through: 102,
      next: 103,
      blocks: [
        timed(102, [
          ratingRecord(bob.principalId, alice.principalId, 12, ratingSet),
          totalRecord(alice.principalId, 12)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([
      [101, 5, 7, 7],
      [102, 7, 12, 12]
    ]);
  });

  it("takes the total from the block's RatingTotal record", async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 3, ratingSet),
          // Other raters the ledger hasn't seen count too.
          totalRecord(alice.principalId, 40)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([[101, 5, 3, 40]]);
  });

  it('counts records after the import without a writer, and their origin is UNKNOWN', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [ratingRecord(bob.principalId, alice.principalId, 8, null)])
      ]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.ratingRecordsWithoutWriter).toBe(1);
    expect(db.ratingEvents[1]).toMatchObject({
      height: 101,
      origin: 'UNKNOWN',
      writer: null
    });
  });

  it('marks only the key of a record it cannot read stale, and skips a category with no name', async () => {
    const { mirror, db, chain, alice, bob, gateway, history } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    const nameless = '0x' + '0e'.repeat(32);
    const unread = ratingKey(bob.principalId, alice.principalId);
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          // A value without its fields: not a removal.
          {
            ...ratingRecord(bob.principalId, alice.principalId, 6, ratingSet),
            valueFields: null
          },
          ratingRecord(
            alice.principalId,
            bob.principalId,
            2,
            ratingSet,
            nameless
          )
        ])
      ]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.events_next_height).toBe(102);
    expect(db.ratingEvents).toHaveLength(1);
    expect(report.ratingEventProblems).toEqual([
      `101:${unread}`,
      `101: no name for the category ${nameless}`
    ]);
    expect(gateway.getState).toHaveBeenCalledWith(`0x0705${'0e'.repeat(32)}`);
    expect(
      db.ledger.get(
        ledgerKeyOf({
          rater: bob.principalId,
          matterCode: 1,
          targetKind: 1,
          target: alice.principalId,
          category: CATEGORY
        })
      )
    ).toMatchObject({ value: 5, stale: true });
    // The chain had 6 from 101: the key's next change reads it there.
    history.set(unread, [
      [60, 5],
      [101, 6]
    ]);
    // A node that hasn't finalized 102 yet: the page waits.
    const notYet = gone('/v1/ratings');
    notYet.read = { finalizedHeight: 101 } as never;
    gateway.getRatingTotals.mockRejectedValueOnce(notYet);
    gateway.getRatingTotals.mockResolvedValue([
      {
        matter: 'REP',
        category: { id: CATEGORY, name: 'Kind' },
        total: '21',
        raters: 3
      }
    ]);
    chain.feed.push({
      from: 102,
      through: 103,
      next: 104,
      blocks: [
        timed(102, [
          ratingRecord(bob.principalId, alice.principalId, 1, ratingSet)
        ]),
        // Another key: its ledger (no row, no gap) is trusted.
        timed(103, [
          ratingRecord(alice.principalId, bob.principalId, 2, ratingSet)
        ])
      ]
    });
    const waiting = await mirror.run({ budgetMs: 60_000 });
    expect(waiting.ratingEventProblems).toEqual(['gone']);
    expect(db.state?.events_next_height).toBe(102);
    expect(feedRows(db.ratingEvents)).toEqual([]);
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([
      [102, 6, 1, 21],
      [103, 0, 2, 2]
    ]);
    expect(gateway.getState).toHaveBeenCalledWith(unread, { height: 101 });
    expect(gateway.getState).not.toHaveBeenCalledWith(
      ratingKey(alice.principalId, bob.principalId),
      expect.anything()
    );
    // Only the stale key's total is read from the chain (twice: it waited).
    expect(gateway.getRatingTotals).toHaveBeenCalledTimes(2);
    expect(gateway.getRatingTotals).toHaveBeenCalledWith(alice.principalId, {
      height: 102
    });
    // Stale again, and the chain no longer holds the totals: the ledger's
    // guess (its sum, 1, plus the change), noted.
    history.set(unread, [
      [60, 5],
      [101, 6],
      [104, 8]
    ]);
    const dropped = gone('/v1/ratings');
    dropped.read = { finalizedHeight: 105 } as never;
    gateway.getRatingTotals.mockRejectedValue(dropped);
    chain.feed.push({
      from: 104,
      through: 105,
      next: 106,
      blocks: [
        timed(104, [
          {
            ...ratingRecord(bob.principalId, alice.principalId, 8, ratingSet),
            valueFields: null
          }
        ]),
        timed(105, [
          ratingRecord(bob.principalId, alice.principalId, 3, ratingSet)
        ])
      ]
    });
    const guessed = await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents).at(-1)).toEqual([105, 8, 3, -4]);
    expect(guessed.ratingEventProblems).toEqual([
      `104:${unread}`,
      '105: a total that may be off'
    ]);
  });

  it('waits for a category name it cannot read, and keeps the names it read', async () => {
    const { mirror, db, chain, alice, bob, gateway } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.categories.set(OTHER, 'Other');
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 4, ratingSet, OTHER)
        ])
      ]
    });
    const stateOf = gateway.getState.getMockImplementation()!;
    let failing = true;
    gateway.getState.mockImplementation((async (
      key: string,
      opts?: { height?: number }
    ) => {
      if (failing && key === `0x0705${'0d'.repeat(32)}`) {
        failing = false;
        throw down('/v1/state');
      }
      return await (stateOf as (k: string, o?: unknown) => Promise<unknown>)(
        key,
        opts
      );
    }) as never);
    const stopped = await mirror.run({ budgetMs: 60_000 });
    expect(stopped.error).toBeUndefined();
    expect(stopped.ratingEventProblems).toEqual(['down']);
    expect(db.state?.events_next_height).toBe(101);
    expect(feedRows(db.ratingEvents)).toEqual([]);
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([[101, 0, 4, 4]]);
    expect(db.categoryNames.get(OTHER)).toBe('Other');
    // A cold start reads the stored names, not the chain.
    forgetNames(mirror);
    gateway.getState.mockClear();
    chain.feed.push({
      from: 102,
      through: 102,
      next: 103,
      blocks: [
        timed(102, [
          ratingRecord(alice.principalId, bob.principalId, 2, ratingSet, OTHER)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents).at(-1)).toEqual([102, 0, 2, 2]);
    expect(gateway.getState).not.toHaveBeenCalled();
  });

  it("leaves out the help bot's credit category and records that change nothing", async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.categories.set(CREDITS, ' help6529 CREDITS ');
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(
            bob.principalId,
            alice.principalId,
            3,
            ratingSet,
            CREDITS
          ),
          // The value the ledger has: an index moved, nothing else.
          ratingRecord(bob.principalId, alice.principalId, 5, ratingScan)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.events_next_height).toBe(102);
    expect(feedRows(db.ratingEvents)).toEqual([]);
  });

  it('writes no row twice when a page is read again', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.ratingEvents).toHaveLength(2);
    // The cursor back (a crash before an earlier save, say): nothing new.
    db.state = { ...db.state!, events_next_height: 50 };
    await mirror.run({ budgetMs: 60_000 });
    expect(db.ratingEvents).toHaveLength(2);
  });

  it('rebuilds the ledger at one pinned height after a gap seen on two runs', async () => {
    const { mirror, db, gateway, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    // The identity sync is past the gap; the follower's place is in it.
    db.state = { ...db.state!, next_height: 500 };
    await db.saveRatingEventsCursor({
      next: 150,
      rebuildHeight: null,
      rebuildAfter: null,
      goneAt: null,
      stuckRuns: 0
    });
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        if (String(from) === '150') {
          throw new ChainGatewayError('gone', 410, 'gone', '/v1/feed');
        }
        return await changesOf(from, opts);
      }
    );
    gateway.getStatus.mockResolvedValue({
      feed: [
        [1, 120],
        [200, 400]
      ]
    } as never);
    // One answer may be a node's: noted, nothing dropped.
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state).toMatchObject({
      events_next_height: 150,
      events_gone_at: 150,
      events_rebuild_height: null
    });
    expect(db.ledger.size).toBe(1);
    // In the gap Bob rated Alice's Kind 9 and her Other 3, and Alice
    // rated Bob's Kind 2: the chain's ratings at the pin.
    chain.finalized = 300;
    chain.categories.set(OTHER, 'Other');
    const rating = (
      rater: string,
      target: string,
      category: string,
      name: string,
      value: string,
      updatedHeight: number
    ) => ({
      rater,
      target,
      matter: 'rep',
      category: { id: category, name },
      value,
      updatedHeight,
      viaGrant: null
    });
    chain.ratings.set(alice.principalId, [
      rating(bob.principalId, alice.principalId, CATEGORY, 'Kind', '9', 170),
      rating(bob.principalId, alice.principalId, OTHER, 'Other', '3', 180)
    ]);
    chain.ratings.set(bob.principalId, [
      rating(alice.principalId, bob.principalId, CATEGORY, 'Kind', '2', 190)
    ]);
    chain.identities.set(bob.principalId, {
      ...bob,
      rep: { total: '2', raters: 1 }
    });
    // A row the chain no longer has: gone with the rebuild.
    db.ledger.set('not-on-the-chain', { value: 1, height: 1, stale: false });
    // One page of identities; their ratings are read at once.
    const listOf = gateway.listIdentities.getMockImplementation()!;
    gateway.listIdentities.mockImplementation((async (opts: {
      height?: number;
      limit?: number;
    }) =>
      opts?.limit === 500
        ? {
            items: Array.from(chain.identities.values()),
            next: null,
            read: {} as never
          }
        : await (listOf as (o: unknown) => Promise<unknown>)(opts)) as never);
    let reading = 0;
    let most = 0;
    const ratingsOf = gateway.getRatings.getMockImplementation()!;
    gateway.getRatings.mockImplementation((async (
      query: { target: string },
      opts?: { height?: number }
    ) => {
      reading++;
      most = Math.max(most, reading);
      await new Promise((resolve) => setImmediate(resolve));
      reading--;
      return await (ratingsOf as (q: unknown, o?: unknown) => Promise<unknown>)(
        query,
        opts
      );
    }) as never);
    const infos = jest.spyOn(
      Logger.get('IDENTITY_CHAIN_RATING_EVENTS'),
      'info'
    );
    const after = await mirror.run({ budgetMs: 60_000 });
    expect(most).toBe(2);
    expect(infos).toHaveBeenCalledWith(
      '[RATING LEDGER REBUILT AT 300] [GOING ON FROM 301] [2 IDENTITIES IN 0 MS THIS RUN]'
    );
    infos.mockRestore();
    expect(db.state).toMatchObject({
      events_next_height: 301,
      events_rebuild_height: null,
      events_gone_at: null,
      // It moved: no longer stuck, though still behind the identities.
      events_stuck_runs: 0
    });
    expect(after.eventsNextHeight).toBe(301);
    expect(gateway.listIdentities).toHaveBeenCalledWith(
      expect.objectContaining({ height: 300, limit: 500 })
    );
    expect(gateway.getRatings).toHaveBeenCalledWith(
      { target: alice.principalId },
      expect.objectContaining({ height: 300 })
    );
    expect(Array.from(db.ledger.values())).toEqual([
      { value: 9, height: 170, stale: false },
      { value: 3, height: 180, stale: false },
      { value: 2, height: 190, stale: false }
    ]);
    // From the pin on, the values before come from the rebuilt ledger.
    chain.feed.push({
      from: 301,
      through: 301,
      next: 302,
      blocks: [
        timed(301, [
          // Back to the value the ledger had before the gap: a change.
          ratingRecord(bob.principalId, alice.principalId, 5, ratingSet),
          totalRecord(alice.principalId, 33),
          ratingRecord(alice.principalId, bob.principalId, 4, ratingSet)
        ])
      ]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([
      [301, 9, 5, 33],
      [301, 2, 4, 4]
    ]);
    expect(gateway.getRatingTotals).not.toHaveBeenCalled();
  });

  it('starts the rebuild again at a newer height when the gateway drops its pin', async () => {
    const { mirror, db, gateway, chain, alice } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.ratings.set(alice.principalId, [
      {
        ...chain.ratings.get(alice.principalId)![0],
        category: { id: CATEGORY, name: 'Kind' }
      }
    ]);
    db.state = { ...db.state!, next_height: 500 };
    await db.saveRatingEventsCursor({
      next: 150,
      rebuildHeight: 120,
      rebuildAfter: null,
      goneAt: null,
      stuckRuns: 0
    });
    // The head moved on: 120 is past the node's last 64 views.
    chain.finalized = 200;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state).toMatchObject({
      events_next_height: 201,
      events_rebuild_height: null
    });
    expect(gateway.listIdentities).toHaveBeenCalledWith(
      expect.objectContaining({ height: 200 })
    );
    expect(Array.from(db.ledger.values())).toEqual([
      { value: 5, height: 30, stale: false }
    ]);
  });

  it('keeps its ledger trusted when the feed is gone at a height it still holds', async () => {
    const { mirror, db, gateway } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    db.state = { ...db.state!, next_height: 500 };
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        if (opts?.families?.includes('0x0704')) {
          throw new ChainGatewayError('gone', 410, 'gone', '/v1/feed');
        }
        return await changesOf(from, opts);
      }
    );
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getStatus).toHaveBeenCalled();
    expect(db.state).toMatchObject({
      events_next_height: 101,
      events_gone_at: null,
      events_rebuild_height: null
    });
    expect(report.eventsNextHeight).toBe(101);
  });

  it('waits for a value before it cannot read yet, and writes UNKNOWN for one gone, even unchanged', async () => {
    const { mirror, db, chain, alice, bob, history } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    const key = ratingKey(bob.principalId, alice.principalId);
    chain.feed.push(
      {
        from: 101,
        through: 101,
        next: 102,
        blocks: [
          // Its value can't be read: the key is stale.
          timed(101, [
            {
              ...ratingRecord(bob.principalId, alice.principalId, 6, ratingSet),
              valueFields: null
            }
          ])
        ]
      },
      {
        from: 102,
        through: 102,
        next: 103,
        blocks: [
          timed(102, [
            // The value the ledger had: a change all the same if 101 set 6.
            ratingRecord(bob.principalId, alice.principalId, 5, ratingSet),
            totalRecord(alice.principalId, 5)
          ])
        ]
      }
    );
    history.set(key, 'down');
    const down1 = await mirror.run({ budgetMs: 60_000 });
    expect(down1.ratingEventProblems).toEqual([`101:${key}`, 'down']);
    expect(db.state?.events_next_height).toBe(102);
    // A node that hasn't finalized 101 yet: still waiting, not UNKNOWN.
    history.set(key, 'not yet');
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.events_next_height).toBe(102);
    expect(feedRows(db.ratingEvents)).toEqual([]);
    // The head moved past the node's last 64 views: gone for good.
    history.delete(key);
    chain.finalized = 300;
    await mirror.run({ budgetMs: 60_000 });
    expect(
      db.ratingEvents
        .filter((it) => it.height > 60)
        .map((it) => [it.height, it.old_rating, it.new_rating, it.origin])
    ).toEqual([[102, 5, 5, 'UNKNOWN']]);
  });

  it('reports a follower stuck behind the identities for the run to fail', async () => {
    const { mirror, db, chain, alice, bob, gateway } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    const errors = jest.spyOn(
      Logger.get('IDENTITY_CHAIN_RATING_EVENTS'),
      'error'
    );
    try {
      chain.categories.set(OTHER, 'Other');
      chain.feed.push({
        from: 101,
        through: 101,
        next: 102,
        blocks: [
          timed(101, [
            ratingRecord(
              bob.principalId,
              alice.principalId,
              4,
              ratingSet,
              OTHER
            )
          ])
        ]
      });
      // A page whose category name can't be read, run after run.
      const stateOf = gateway.getState.getMockImplementation()!;
      gateway.getState.mockImplementation((async (
        key: string,
        opts?: { height?: number }
      ) => {
        if (key === `0x0705${'0d'.repeat(32)}`) throw down('/v1/state');
        return await (stateOf as (k: string, o?: unknown) => Promise<unknown>)(
          key,
          opts
        );
      }) as never);
      for (let run = 1; run < RATING_EVENTS_STUCK_RUNS; run++) {
        const report = await mirror.run({ budgetMs: 60_000 });
        expect(report.ratingEventsStuck).toBeUndefined();
        expect(db.state?.events_stuck_runs).toBe(run);
      }
      const stuck = await mirror.run({ budgetMs: 60_000 });
      expect(stuck.error).toBeUndefined();
      expect(stuck.ratingEventsStuck).toBe(
        `Rating events stuck at 101 for ${RATING_EVENTS_STUCK_RUNS} runs: down`
      );
      expect(errors).toHaveBeenCalledWith(
        `[RATING EVENTS STUCK] ${stuck.ratingEventsStuck}`
      );
      // Moving again clears it.
      gateway.getState.mockImplementation(stateOf);
      const moving = await mirror.run({ budgetMs: 60_000 });
      expect(moving.ratingEventsStuck).toBeUndefined();
      expect(db.state?.events_stuck_runs).toBe(0);
      expect(feedRows(db.ratingEvents)).toEqual([[101, 0, 4, 4]]);
      // Caught up with the identities, runs that read nothing are not stuck.
      for (let run = 0; run <= RATING_EVENTS_STUCK_RUNS; run++) {
        expect(
          (await mirror.run({ budgetMs: 60_000 })).ratingEventsStuck
        ).toBeUndefined();
      }
      expect(db.state?.events_stuck_runs).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  it('lists the first 50 problems of a run and counts the rest, and cuts a long category name', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    const long = 'L'.repeat(150);
    chain.categories.set(OTHER, long);
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ...Array.from({ length: 60 }, (_, i) => ({
            ...ratingRecord('x', alice.principalId, 1, ratingSet),
            key: `0x${i}`
          })),
          ratingRecord(bob.principalId, alice.principalId, 4, ratingSet, OTHER)
        ])
      ]
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.ratingEventProblems).toHaveLength(50);
    expect(report.ratingEventProblemsLeftOut).toBe(11);
    expect(feedRows(db.ratingEvents)).toEqual([[101, 0, 4, 4]]);
    expect(db.ratingEvents[1].matter_category).toBe('L'.repeat(100));
  });

  it('reads nothing before the identity sync has a place, and drops a page when its time runs out', async () => {
    const { db, chain, alice, bob, gateway } = ratedWorld();
    let now = 1_000;
    const follower = new RatingEventsFollower(
      gateway as never,
      db as unknown as IdentityChainMirrorDb,
      new ProfileIds(gateway as never, db as never, () => now),
      () => now,
      async () => undefined
    );
    const report = () => ({
      ratingEvents: 0,
      ratingEventProblems: [] as string[],
      ratingEventProblemsLeftOut: 0,
      ratingRecordsWithoutWriter: 0,
      eventsNextHeight: null as number | null
    });
    db.state = {
      next_height: null,
      chain_id: null,
      events_next_height: 101,
      events_rebuild_height: null,
      events_rebuild_after: null,
      events_gone_at: null,
      events_stuck_runs: 0
    } as never;
    await follower.follow(50, 60, 2_000, report());
    expect(gateway.getChanges).not.toHaveBeenCalled();
    // Two categories to read; the first read takes the run's time.
    const third = '0x' + '0f'.repeat(32);
    chain.categories.set(OTHER, 'Other');
    chain.categories.set(third, 'Third');
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 4, ratingSet, OTHER),
          ratingRecord(bob.principalId, alice.principalId, 2, ratingSet, third)
        ])
      ]
    });
    db.state = { ...(db.state as MirrorState), next_height: 200 };
    const stateOf = gateway.getState.getMockImplementation()!;
    gateway.getState.mockImplementation((async (key: string) => {
      now = 5_000;
      return await (stateOf as (k: string) => Promise<unknown>)(key);
    }) as never);
    const short = report();
    await follower.follow(50, 60, 2_000, short);
    expect(short.ratingEventProblems).toEqual([]);
    expect(db.state?.events_next_height).toBe(101);
    expect(db.ratingEvents).toEqual([]);
    await follower.follow(50, 60, 10_000, report());
    expect(db.ratingEvents.map((it) => it.matter_category)).toEqual([
      'Other',
      'Third'
    ]);
  });

  it('starts from the import with an empty ledger and log', async () => {
    const { mirror, db, chain } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    // Left from an earlier start: cleared with the first place.
    db.state = { ...db.state!, events_next_height: null };
    db.ledger.set('left-over', { value: 3, height: 1, stale: false });
    db.ratingEvents = [{ height: 1 } as never];
    db.categoryNames.set(OTHER, 'Old');
    chain.importStart = 50;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.ledger.has('left-over')).toBe(false);
    expect(db.categoryNames.has(OTHER)).toBe(false);
    expect(db.ratingEvents.map((it) => it.height)).toEqual([60]);
    expect(db.state?.events_next_height).toBe(101);
  });

  it('builds the ledger at the latest height without an import start', async () => {
    const { mirror, db, chain, alice } = ratedWorld();
    const errors = jest.spyOn(
      Logger.get('IDENTITY_CHAIN_RATING_EVENTS'),
      'error'
    );
    chain.importStart = null;
    chain.ratings.set(alice.principalId, [
      {
        ...chain.ratings.get(alice.principalId)![0],
        category: { id: CATEGORY, name: 'Kind' }
      }
    ]);
    try {
      const report = await mirror.run({ budgetMs: 60_000 });
      expect(errors).toHaveBeenCalledWith(
        '[NO IMPORT START] [NO RATING EVENTS UP TO 100] [THE LEDGER IS BUILT AT 100]'
      );
      expect(report.eventsNextHeight).toBe(101);
    } finally {
      errors.mockRestore();
    }
    expect(db.state).toMatchObject({
      events_next_height: 101,
      events_rebuild_height: null
    });
    expect(db.ratingEvents).toEqual([]);
    expect(Array.from(db.ledger.values())).toEqual([
      { value: 5, height: 30, stale: false }
    ]);
  });

  /** A first full sync that stops after setting the identity sync's place. */
  const firstSyncStops = (
    gateway: ReturnType<typeof ratedWorld>['gateway'],
    runs = 1
  ) => {
    for (let i = 0; i < runs; i++) {
      gateway.listIdentities.mockRejectedValueOnce(new Error('timeout'));
    }
  };
  /** Bob rates Alice 7 after the import, below the full sync's height. */
  const bobRatesAliceAt70 = (w: ReturnType<typeof ratedWorld>) =>
    w.chain.feed[0].blocks.push(
      timed(70, [
        ratingRecord(w.bob.principalId, w.alice.principalId, 7, ratingSet)
      ])
    );
  const idsOf = (rows: RatingEventRow[]) =>
    rows.map((it) => [
      it.height,
      it.origin,
      it.rater_profile_id,
      it.target_profile_id
    ]);

  it("waits for the identity sync's place only, and maps nothing for the import's rows", async () => {
    const { mirror, db, gateway, bob } = ratedWorld();
    firstSyncStops(gateway);
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(first.error).toBe('timeout');
    expect(db.state).toMatchObject({
      last_full_sync_at: null,
      next_height: 101,
      events_next_height: 101
    });
    // Written during the first full sync; an IMPORT row maps no one.
    expect(idsOf(db.ratingEvents)).toEqual([[60, 'IMPORT', null, null]]);
    expect(db.mapping.size).toBe(0);
    expect(gateway.getIdentityByPrincipal).not.toHaveBeenCalled();
    const second = await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.last_full_sync_at).not.toBeNull();
    // The full sync mapped both: the fill sets them.
    expect(second.ratingEventsFilled).toBe(1);
    expect(idsOf(db.ratingEvents)).toEqual([
      [60, 'IMPORT', db.mapping.get(bob.principalId)?.profile, ALICE_PROFILE]
    ]);
  });

  it('maps the rater and target of a rating during the first full sync, and the sync keeps their ids', async () => {
    const w = ratedWorld();
    const { mirror, db, gateway, alice, bob } = w;
    bobRatesAliceAt70(w);
    firstSyncStops(gateway);
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.last_full_sync_at).toBeNull();
    const bobId = principalProfileId(bob.principalId);
    expect(idsOf(db.ratingEvents)).toEqual([
      // The import's row of the same page takes the ids mapped for the next.
      [60, 'IMPORT', bobId, ALICE_PROFILE],
      [70, 'OPERATION', bobId, ALICE_PROFILE]
    ]);
    expect(db.mapping.get(bob.principalId)).toEqual({
      profile: bobId,
      origin: 'NEW'
    });
    expect(db.mapping.get(alice.principalId)).toEqual({
      profile: ALICE_PROFILE,
      origin: 'LEGACY'
    });
    // Read at the finalized height, at or past the page.
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledWith(
      bob.principalId,
      { height: 100 }
    );
    // The full sync finds the mappings: the same ids on 6529.io's rows.
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.last_full_sync_at).not.toBeNull();
    expect(db.mapping.get(bob.principalId)?.profile).toBe(bobId);
    const profiles = Array.from(db.rows.values()).map((it) => it.profile_id);
    expect(profiles).toContain(bobId);
    expect(profiles).toContain(ALICE_PROFILE);
    expect(
      db.ratings.get(ALICE_PROFILE)?.map((it) => it.rater_profile_id)
    ).toEqual([bobId]);
  });

  it('writes a row whose rater waits on its founder without its id, filled once mapped', async () => {
    const { mirror, db, chain, gateway, alice, tick } = ratedWorld();
    // The bindings came from a membership list: the history decides.
    db.state = {
      next_height: null,
      sync_from_height: null,
      sync_phase: null,
      sync_after: null,
      last_full_sync_at: null,
      bindings_next_height: 101,
      chain_id: null,
      placeholders_at: null,
      bindings_exact: false,
      levels_tdh_day: null,
      level_sweep_day: null,
      level_sweep_after: null,
      levels_day_height: null,
      sync_use_case: null,
      sync_wallet_after: null,
      pin_floor: null,
      off_chain_after: null,
      events_next_height: null,
      events_rebuild_height: null,
      events_rebuild_after: null,
      events_gone_at: null,
      events_stuck_runs: 0,
      retry: NOTHING_TO_RETRY
    };
    const carol = chainIdentity(PID(99), [W(99)], {
      legacyId: null,
      founder: W(99),
      createdHeight: 52
    });
    chain.identities.set(carol.principalId, carol);
    db.placeholders.set(W(99), 'p-maybe');
    // The node's history starts after the import's start: it can't say.
    const historyOf =
      gateway.getMembershipWalletHistory.getMockImplementation()!;
    gateway.getMembershipWalletHistory.mockImplementation((async (
      wallet: string
    ) =>
      wallet === W(99)
        ? {
            wallet,
            changes: [{ height: 52, principalId: carol.principalId }],
            ranges: [[55, 1000]],
            readHeight: 100
          }
        : await historyOf(wallet)) as never);
    chain.feed[0].blocks.push(
      timed(70, [
        ratingRecord(carol.principalId, alice.principalId, 3, ratingSet)
      ])
    );
    firstSyncStops(gateway);
    await mirror.run({ budgetMs: 60_000 });
    expect(idsOf(db.ratingEvents.filter((it) => it.height === 70))).toEqual([
      [70, 'OPERATION', null, ALICE_PROFILE]
    ]);
    expect(db.mapping.has(carol.principalId)).toBe(false);
    expect(db.founderWaits.has(carol.principalId)).toBe(true);
    // Past the wait the full sync maps it; the fill sets the row's id.
    tick(FOUNDER_WAIT_MS);
    const second = await mirror.run({ budgetMs: 60_000 });
    const carolId = principalProfileId(carol.principalId);
    expect(db.mapping.get(carol.principalId)?.profile).toBe(carolId);
    expect(second.ratingEventsFilled).toBeGreaterThanOrEqual(1);
    expect(idsOf(db.ratingEvents.filter((it) => it.height === 70))).toEqual([
      [70, 'OPERATION', carolId, ALICE_PROFILE]
    ]);
  });

  it.each([
    ['a 5xx', () => down('/v1/identities')],
    [
      'a timeout',
      () =>
        new ChainGatewayError('timed out', null, 'timeout', '/v1/identities')
    ],
    ['a height not held', () => gone('/v1/identities')]
  ])(
    'leaves the page for the next run on %s while mapping',
    async (_, failure) => {
      const w = ratedWorld();
      const { mirror, db, gateway, bob } = w;
      bobRatesAliceAt70(w);
      firstSyncStops(gateway, 2);
      const error = failure();
      gateway.getIdentityByPrincipal.mockRejectedValueOnce(error);
      const first = await mirror.run({ budgetMs: 60_000 });
      expect(first.ratingEventProblems).toContain(error.message);
      expect(db.state?.events_next_height).toBe(50);
      expect(db.ratingEvents).toEqual([]);
      const second = await mirror.run({ budgetMs: 60_000 });
      expect(second.ratingEventProblems).toEqual([]);
      expect(db.state?.events_next_height).toBe(101);
      const bobId = principalProfileId(bob.principalId);
      expect(idsOf(db.ratingEvents)).toEqual([
        [60, 'IMPORT', bobId, ALICE_PROFILE],
        [70, 'OPERATION', bobId, ALICE_PROFILE]
      ]);
    }
  );

  it("writes the page without the id of an identity that can't be mapped, holding no other row back", async () => {
    const { mirror, db, chain, gateway, alice, bob } = ratedWorld();
    // One answer without wallets (isInactive can't read it), one refused
    // for good: each would fail the same way every run.
    const noWallets = {
      ...chainIdentity(PID(95), [W(95)]),
      wallets: undefined
    } as unknown as ChainIdentity;
    const refused = chainIdentity(PID(94), [W(94)]);
    chain.identities.set(noWallets.principalId, noWallets);
    chain.identities.set(refused.principalId, refused);
    const read = gateway.getIdentityByPrincipal.getMockImplementation()!;
    gateway.getIdentityByPrincipal.mockImplementation((async (p: string) => {
      if (p === refused.principalId) {
        throw new ChainGatewayError('no', 400, 'bad_request', '/v1/identities');
      }
      return await read(p);
    }) as never);
    chain.feed[0].blocks.push(
      timed(70, [
        ratingRecord(noWallets.principalId, alice.principalId, 1, ratingSet),
        ratingRecord(refused.principalId, alice.principalId, 2, ratingSet),
        ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
      ])
    );
    firstSyncStops(gateway);
    const report = await mirror.run({ budgetMs: 60_000 });
    const bobId = principalProfileId(bob.principalId);
    expect(idsOf(db.ratingEvents.filter((it) => it.height === 70))).toEqual([
      [70, 'OPERATION', null, ALICE_PROFILE],
      [70, 'OPERATION', null, ALICE_PROFILE],
      [70, 'OPERATION', bobId, ALICE_PROFILE]
    ]);
    expect(db.state?.events_next_height).toBe(101);
    expect(report.ratingEventProblems).toEqual([
      expect.stringContaining(`${noWallets.principalId} not mapped:`),
      expect.stringContaining(`${refused.principalId} not mapped: no`)
    ]);
  });

  /**
   * A follower of its own, with its clock, from height 101 (behind 102);
   * each identity read takes `readMs`.
   */
  const followerAt101 = (
    w: ReturnType<typeof ratedWorld>,
    { readMs = 0 }: { readMs?: number } = {}
  ) => {
    const clock = { now: 1_000 };
    const ids = new ProfileIds(
      w.gateway as never,
      w.db as never,
      () => clock.now
    );
    ids.setImportHeights(50, 60);
    const make = () =>
      new RatingEventsFollower(
        w.gateway as never,
        w.db as unknown as IdentityChainMirrorDb,
        ids,
        () => clock.now,
        async () => undefined
      );
    let follower = make();
    const read = w.gateway.getIdentityByPrincipal.getMockImplementation()!;
    w.gateway.getIdentityByPrincipal.mockImplementation((async (p: string) => {
      clock.now += readMs;
      return await read(p);
    }) as never);
    w.db.state = {
      next_height: 102,
      last_full_sync_at: null,
      chain_id: null,
      events_next_height: 101,
      events_rebuild_height: null,
      events_rebuild_after: null,
      events_gone_at: null,
      events_stuck_runs: 0
    } as unknown as MirrorState;
    w.chain.categories.set(CATEGORY, 'Kind');
    return {
      /** One run of `budgetMs`; `cold`: a new follower, nothing in memory. */
      follow: async (budgetMs = 60_000, cold = false) => {
        if (cold) follower = make();
        const report: RatingEventsReport = {
          ratingEvents: 0,
          ratingEventProblems: [],
          ratingEventProblemsLeftOut: 0,
          ratingRecordsWithoutWriter: 0,
          eventsNextHeight: null
        };
        clock.now += 1_000;
        await follower.follow(50, 60, clock.now + budgetMs, report);
        return report;
      }
    };
  };
  /** Raters of Alice at 101, by default each a new identity made on the chain. */
  const ratersAt101 = (
    w: ReturnType<typeof ratedWorld>,
    count: number,
    make = (i: number) => chainIdentity(PID(1000 + i), [W(1000 + i)])
  ) => {
    const raters = Array.from({ length: count }, (_, i) => make(i));
    raters.forEach((it) => w.chain.identities.set(it.principalId, it));
    w.chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(
          101,
          raters.map((it) =>
            ratingRecord(it.principalId, w.alice.principalId, 1, ratingSet)
          )
        )
      ]
    });
    return raters;
  };

  it(`maps ${RATING_EVENTS_MAPPED_A_PAGE} raters and targets a try of the page, reading it again for the rest`, async () => {
    const w = ratedWorld();
    const { db } = w;
    // 249 raters and Alice: 250 to map, a second each.
    ratersAt101(w, 249);
    const { follow } = followerAt101(w, { readMs: 1_000 });
    const info = jest.spyOn(Logger.get('IDENTITY_CHAIN_RATING_EVENTS'), 'info');
    try {
      // Time for 205: the second try of the page runs out.
      await follow(205_000);
      expect(info).toHaveBeenCalledWith(
        `[RATING EVENTS: ${RATING_EVENTS_MAPPED_A_PAGE} RATERS AND TARGETS MAPPED FOR NOTIFICATIONS] [50 NOT TRIED YET: THE PAGE IS READ AGAIN]`
      );
    } finally {
      info.mockRestore();
    }
    expect(db.ratingEvents).toEqual([]);
    expect(db.mapping.size).toBe(205);
    // Ids stored: a step on, not a stuck run.
    expect(db.state).toMatchObject({
      events_next_height: 101,
      events_stuck_runs: 0
    });
    await follow(205_000);
    expect(db.mapping.size).toBe(250);
    expect(db.state?.events_next_height).toBe(102);
    expect(db.ratingEvents).toHaveLength(249);
    expect(
      db.ratingEvents.filter(
        (it) => it.rater_profile_id === null || it.target_profile_id === null
      )
    ).toEqual([]);
  });

  it('tries the ids not tried yet first, and writes a page once none left can be settled', async () => {
    const w = ratedWorld();
    const { db, gateway } = w;
    // 201 raters no node can settle yet (no import entry held), then ten
    // that map.
    const raters = ratersAt101(w, RATING_EVENTS_MAPPED_A_PAGE + 11);
    const unsettled = new Set(
      raters
        .slice(0, RATING_EVENTS_MAPPED_A_PAGE + 1)
        .map((it) => it.principalId)
    );
    gateway.getImportedIdentity.mockImplementation((async (p: string) => {
      if (unsettled.has(p)) {
        throw new ChainGatewayError('not here', 404, 'not_held', '/v1/import');
      }
      return null;
    }) as never);
    const { follow } = followerAt101(w);
    // Alice and 199 unsettled; then the two and the ten not tried yet with
    // 188 tried before; then none of those left settles: written.
    await follow();
    expect(db.mapping.size).toBe(11);
    expect(db.state?.events_next_height).toBe(102);
    expect(db.ratingEvents).toHaveLength(RATING_EVENTS_MAPPED_A_PAGE + 11);
    expect(
      db.ratingEvents.every(
        (it) =>
          (it.rater_profile_id === null) ===
            unsettled.has(it.rater_principal) &&
          it.target_profile_id === ALICE_PROFILE
      )
    ).toBe(true);
  });

  /** 210 raters of Alice, merged into her; Alice mapped already. */
  const mergedRatersAt101 = (w: ReturnType<typeof ratedWorld>) => {
    w.db.mapping.set(w.alice.principalId, {
      profile: ALICE_PROFILE,
      origin: 'LEGACY'
    });
    return ratersAt101(w, 210, (i) =>
      chainIdentity(PID(2000 + i), [], {
        legacyId: null,
        mergedInto: w.alice.principalId
      })
    );
  };

  it('names merged raters once a page, and writes their rows within a few runs', async () => {
    const w = ratedWorld();
    const { db, gateway } = w;
    const merged = mergedRatersAt101(w);
    const { follow } = followerAt101(w, { readMs: 1_000 });
    // 200 named on the first try, five on the second: out of time. Nothing
    // stored: no step on.
    await follow(205_000);
    expect(db.ratingEvents).toEqual([]);
    expect(db.state?.events_stuck_runs).toBe(1);
    // The 205 named come from memory: five more to read, then written.
    await follow(205_000);
    expect(db.state).toMatchObject({
      events_next_height: 102,
      events_stuck_runs: 0
    });
    expect(db.ratingEvents).toHaveLength(210);
    expect(
      db.ratingEvents.every(
        (it) =>
          it.rater_profile_id === principalProfileId(it.rater_principal) &&
          it.target_profile_id === ALICE_PROFILE
      )
    ).toBe(true);
    expect(merged.some((it) => db.mapping.has(it.principalId))).toBe(false);
    // Each read once.
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledTimes(210);
  });

  it('raises the stuck alarm when a page of merged raters can never be written', async () => {
    const w = ratedWorld();
    const { db } = w;
    mergedRatersAt101(w);
    const { follow } = followerAt101(w, { readMs: 1_000 });
    // A cold start every run: what was named is forgotten each time.
    let report: RatingEventsReport | null = null;
    for (let i = 0; i < RATING_EVENTS_STUCK_RUNS; i++) {
      report = await follow(205_000, true);
    }
    expect(db.ratingEvents).toEqual([]);
    expect(db.state?.events_stuck_runs).toBe(RATING_EVENTS_STUCK_RUNS);
    expect(report?.ratingEventsStuck).toMatch(/^Rating events stuck at 101/);
  });

  it.each([
    ['ER_LOCK_DEADLOCK', { code: 'ER_LOCK_DEADLOCK' }],
    ['PROTOCOL_CONNECTION_LOST', { code: 'PROTOCOL_CONNECTION_LOST' }],
    ['PROTOCOL_SEQUENCE_TIMEOUT', { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }],
    ['ETIMEDOUT', { code: 'ETIMEDOUT' }],
    ['ER_OPTION_PREVENTS_STATEMENT', { code: 'ER_OPTION_PREVENTS_STATEMENT' }],
    ['a fatal error', { code: 'ER_UNKNOWN_ERROR', fatal: true }]
  ])(
    'leaves the page for the next run on %s while mapping',
    async (_, failure) => {
      const w = ratedWorld();
      const { mirror, db, gateway, bob } = w;
      bobRatesAliceAt70(w);
      firstSyncStops(gateway, 2);
      const insert = db.insertMapping.bind(db);
      db.insertMapping = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('locked'), failure))
        .mockImplementation(insert) as never;
      const first = await mirror.run({ budgetMs: 60_000 });
      expect(first.ratingEventProblems).toContain('locked');
      expect(db.ratingEvents).toEqual([]);
      await mirror.run({ budgetMs: 60_000 });
      const bobId = principalProfileId(bob.principalId);
      expect(idsOf(db.ratingEvents)).toEqual([
        [60, 'IMPORT', bobId, ALICE_PROFILE],
        [70, 'OPERATION', bobId, ALICE_PROFILE]
      ]);
    }
  );

  it('holds the page for a principal that keeps failing in passing, and raises the stuck alarm', async () => {
    const w = ratedWorld();
    const { db, gateway } = w;
    const [rater] = ratersAt101(w, 1);
    const { follow } = followerAt101(w);
    const read = gateway.getIdentityByPrincipal.getMockImplementation()!;
    gateway.getIdentityByPrincipal.mockImplementation((async (p: string) => {
      if (p === rater.principalId) throw down('/v1/identities');
      return await read(p);
    }) as never);
    let report: RatingEventsReport | null = null;
    for (let i = 0; i < RATING_EVENTS_STUCK_RUNS; i++) {
      report = await follow();
      expect(report.ratingEventProblems).toEqual(['down']);
    }
    // No row written with an empty id: a person looks.
    expect(db.ratingEvents).toEqual([]);
    expect(db.state?.events_stuck_runs).toBe(RATING_EVENTS_STUCK_RUNS);
    expect(report?.ratingEventsStuck).toMatch(/^Rating events stuck at 101/);
  });

  it('counts no step on for an id that was stored before the call', async () => {
    const w = ratedWorld();
    const { db } = w;
    w.db.mapping.set(w.alice.principalId, {
      profile: ALICE_PROFILE,
      origin: 'LEGACY'
    });
    // Three raters mapped already, which the page's read of the mappings
    // doesn't see: each is named from its mapping, nothing stored.
    const raters = ratersAt101(w, 3);
    raters.forEach((it) =>
      db.mapping.set(it.principalId, {
        profile: principalProfileId(it.principalId),
        origin: 'NEW'
      })
    );
    const hidden = new Set(raters.map((it) => it.principalId));
    const mappingsOf = db.profileIdsOfPrincipals.bind(db);
    db.profileIdsOfPrincipals = (async (principals: string[]) =>
      await mappingsOf(principals.filter((it) => !hidden.has(it)))) as never;
    const { follow } = followerAt101(w, { readMs: 1_000 });
    // Time for two reads: out of time before the third.
    await follow(1_500);
    expect(db.ratingEvents).toEqual([]);
    expect(db.state?.events_stuck_runs).toBe(1);
  });

  it('forgets the names of a page it is on when the chain changes', async () => {
    const w = ratedWorld();
    const { db, gateway } = w;
    mergedRatersAt101(w);
    const { follow } = followerAt101(w, { readMs: 1_000 });
    // 205 of the 210 named: out of time.
    await follow(205_000);
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledTimes(205);
    // Another chain: nothing named on the old one is taken, so the same
    // time names 205 again, and the page isn't written.
    db.state = { ...db.state!, chain_id: 'another' };
    await follow(205_000);
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledTimes(410);
    expect(db.ratingEvents).toEqual([]);
  });

  it('gives the rating events a minute when the identity steps run into their time, never past the run by more', async () => {
    for (const [overrun, written] of [
      [70_000, true],
      [200_000, false]
    ] as const) {
      const w = ratedWorld();
      bobRatesAliceAt70(w);
      const list = w.gateway.listIdentities.getMockImplementation()!;
      w.gateway.listIdentities.mockImplementationOnce((async (opts: {
        after?: string | null;
      }) => {
        w.tick(overrun);
        return await list(opts);
      }) as never);
      await w.mirror.run({ budgetMs: 60_000 });
      expect(w.db.ratingEvents.length > 0).toBe(written);
    }
  });

  it('names a merged rater of a rating as the full sync does, without mapping it', async () => {
    const { mirror, db, chain, gateway, alice } = ratedWorld();
    const merged = chainIdentity(PID(97), [], {
      legacyId: null,
      mergedInto: alice.principalId
    });
    chain.identities.set(merged.principalId, merged);
    chain.feed[0].blocks.push(
      timed(70, [
        ratingRecord(merged.principalId, alice.principalId, 2, ratingSet)
      ])
    );
    firstSyncStops(gateway);
    await mirror.run({ budgetMs: 60_000 });
    expect(idsOf(db.ratingEvents.filter((it) => it.height === 70))).toEqual([
      [70, 'OPERATION', principalProfileId(PID(97)), ALICE_PROFILE]
    ]);
    expect(db.mapping.has(merged.principalId)).toBe(false);
  });

  it('drops the page when its time runs out between the ids it maps, keeping those mapped', async () => {
    const { db, chain, gateway, alice, bob } = ratedWorld();
    let now = 1_000;
    const ids = new ProfileIds(gateway as never, db as never, () => now);
    ids.setImportHeights(50, 60);
    const follower = new RatingEventsFollower(
      gateway as never,
      db as unknown as IdentityChainMirrorDb,
      ids,
      () => now,
      async () => undefined
    );
    const report = () => ({
      ratingEvents: 0,
      ratingEventProblems: [] as string[],
      ratingEventProblemsLeftOut: 0,
      ratingRecordsWithoutWriter: 0,
      eventsNextHeight: null as number | null
    });
    db.state = {
      next_height: 102,
      last_full_sync_at: null,
      chain_id: null,
      events_next_height: 101,
      events_rebuild_height: null,
      events_rebuild_after: null,
      events_gone_at: null,
      events_stuck_runs: 0
    } as unknown as MirrorState;
    chain.categories.set(CATEGORY, 'Kind');
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 4, ratingSet)
        ])
      ]
    });
    // Each identity read takes five seconds.
    const read = gateway.getIdentityByPrincipal.getMockImplementation()!;
    gateway.getIdentityByPrincipal.mockImplementation((async (p: string) => {
      now += 5_000;
      return await read(p);
    }) as never);
    const short = report();
    await follower.follow(50, 60, 2_000, short);
    expect(short.ratingEventProblems).toEqual([]);
    // Bob was mapped; the time ran out before Alice: nothing written.
    expect(db.mapping.has(bob.principalId)).toBe(true);
    expect(db.mapping.has(alice.principalId)).toBe(false);
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledTimes(1);
    expect(db.ratingEvents).toEqual([]);
    expect(db.state?.events_next_height).toBe(101);
    await follower.follow(50, 60, now + 60_000, report());
    expect(idsOf(db.ratingEvents)).toEqual([
      [101, 'OPERATION', principalProfileId(bob.principalId), ALICE_PROFILE]
    ]);
    expect(db.state?.events_next_height).toBe(102);
  });

  it('follows the rating events when an identity step throws', async () => {
    const { mirror, db, chain, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.last_full_sync_at).not.toBeNull();
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
        ])
      ]
    });
    db.fixLevelsOffTheChain = jest.fn(async () => {
      throw new Error('levels down');
    }) as never;
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBe('levels down');
    expect(feedRows(db.ratingEvents)).toEqual([[101, 5, 7, 7]]);
  });

  it("writes no row past the identity sync's place", async () => {
    const { mirror, db, chain, gateway, alice, bob } = ratedWorld();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        timed(101, [
          ratingRecord(bob.principalId, alice.principalId, 7, ratingSet)
        ])
      ]
    });
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        // The identity sync reads the whole feed: it can't now.
        if (!opts?.families) throw down('/v1/feed');
        return await changesOf(from, opts);
      }
    );
    const stopped = await mirror.run({ budgetMs: 60_000 });
    expect(stopped.error).toBe('down');
    expect(db.state?.next_height).toBe(101);
    expect(db.state?.events_next_height).toBe(101);
    expect(feedRows(db.ratingEvents)).toEqual([]);
    gateway.getChanges.mockImplementation(changesOf);
    await mirror.run({ budgetMs: 60_000 });
    expect(feedRows(db.ratingEvents)).toEqual([[101, 5, 7, 7]]);
  });

  it("fills in the profile ids of the last day's rating events once mapped", async () => {
    const { mirror, db, alice, bob, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    tick(2 * 24 * 60 * 60 * 1000);
    const now = 1_000 + 2 * 24 * 60 * 60 * 1000;
    const event = (createdAt: number, height: number) => ({
      height,
      block_time_ms: 0,
      rater_principal: bob.principalId,
      rater_profile_id: null,
      target_principal: alice.principalId,
      target_profile_id: null,
      matter: 'REP' as const,
      matter_category: 'Kind',
      old_rating: 0,
      new_rating: 1,
      total_after: 1,
      origin: 'OPERATION',
      by_import: false,
      writer: 'tx:RATING_SET',
      created_at: createdAt
    });
    // A row of an old block written now (a catch-up), and one written long ago.
    db.ratingEvents = [event(now - 1_000, 1), event(1_000, 2)];
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.ratingEventsFilled).toBe(1);
    expect(db.ratingEvents[0]).toMatchObject({
      rater_profile_id: db.mapping.get(bob.principalId)?.profile,
      target_profile_id: ALICE_PROFILE
    });
    expect(db.ratingEvents[1].target_profile_id).toBeNull();
  });

  it('gives the fill a bound and a share of the time, and its place from the run before', async () => {
    const { mirror, db, tick } = world();
    const fill = jest
      .fn()
      .mockResolvedValueOnce({ filled: 3, after: 70 })
      .mockResolvedValue({ filled: 0, after: null });
    db.fillRatingEventProfiles = fill as never;
    const first = await mirror.run({ budgetMs: 60_000 });
    expect(first.ratingEventsFilled).toBe(3);
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    const opts = fill.mock.calls.map(
      ([, it]) => it as { after: number | null; maxIds: number }
    );
    expect(opts.map((it) => it.after)).toEqual([null, 70, null]);
    expect(opts.every((it) => it.maxIds === 500_000)).toBe(true);
    // The first pass after the full sync ended covers every row, across
    // runs; then the last day's.
    expect(fill.mock.calls.map(([since]) => since)).toEqual([
      0,
      0,
      1_000 - 24 * 60 * 60 * 1000
    ]);
    // A quarter of the rating events' time (all of it, here: 60 s).
    const inTime = (fill.mock.calls[2][1] as { inTime: () => boolean }).inTime;
    tick(14_000);
    expect(inTime()).toBe(true);
    tick(2_000);
    expect(inTime()).toBe(false);
  });

  it("fills the import's rows when the first full sync ends more than a day after them", async () => {
    const { mirror, db, gateway, bob, tick } = ratedWorld();
    const fillOf = db.fillRatingEventProfiles.bind(db);
    const fill = jest.fn((since: number) => fillOf(since));
    db.fillRatingEventProfiles = fill as never;
    firstSyncStops(gateway);
    await mirror.run({ budgetMs: 60_000 });
    expect(idsOf(db.ratingEvents)).toEqual([[60, 'IMPORT', null, null]]);
    // The first full sync ends two days later.
    tick(2 * 24 * 60 * 60 * 1000);
    const second = await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.last_full_sync_at).not.toBeNull();
    expect(second.ratingEventsFilled).toBe(1);
    expect(idsOf(db.ratingEvents)).toEqual([
      [60, 'IMPORT', db.mapping.get(bob.principalId)?.profile, ALICE_PROFILE]
    ]);
    await mirror.run({ budgetMs: 60_000 });
    // Every row until the full sync ended and one pass after; then a day.
    const now = 1_000 + 2 * 24 * 60 * 60 * 1000;
    expect(fill.mock.calls.map(([since]) => since)).toEqual([
      0,
      0,
      now - 24 * 60 * 60 * 1000
    ]);
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

  it('stops on another chain without the stage flag, wiping nothing', async () => {
    const { mirror, db, chain } = world();
    chain.network = '0x' + 'aa'.repeat(32);
    await mirror.run({ budgetMs: 60_000 });
    db.mapping.set(PID(98), { profile: 'made-on-this-chain', origin: 'NEW' });
    chain.network = '0x' + 'bb'.repeat(32);
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toContain('another chain');
    expect(db.state?.chain_id).toBe('0x' + 'aa'.repeat(32));
    expect(db.mapping.has(PID(98))).toBe(true);
    expect(db.state?.next_height).toBe(101);
  });

  it('starts again on another chain, also while its import runs, but not for a lagging node', async () => {
    process.env[RELAUNCH_ALLOWED_ENV] = 'true';
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
    db.ledger.set('of-the-old-chain', { value: 3, height: 50, stale: false });
    db.ratingEvents = [{ height: 50 } as never];
    db.state = { ...db.state!, events_next_height: 120 };
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
    // The rating events and their ledger start again with the new import.
    expect(db.ledger.size).toBe(0);
    expect(db.ratingEvents).toEqual([]);
    expect(db.state?.events_next_height).toBeNull();
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
    const { mirror, db, gateway, chain, tick } = world();
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
    // One node's answer decides nothing: tried again for six hours.
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      retryLater: true,
      reason: 'founder_unknown_yet'
    });
    expect(db.mapping.has(PID(99))).toBe(false);
    tick(FOUNDER_WAIT_MS - 1);
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      reason: 'founder_unknown_yet'
    });
    tick(1);
    expect(await mirror.profileIdOf(made)).toBe(principalProfileId(PID(99)));
    expect(db.mapping.get(PID(99))?.origin).toBe('NEW');
    expect(db.founderWaits.size).toBe(0);
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
    const { mirror, db, chain, tick } = world();
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
    const first = await mirror.run({ budgetMs: 60_000 });
    // The bindings come from a membership list: not exact.
    expect(db.state?.bindings_exact).toBe(false);
    // Waited on before it is decided.
    expect(db.mapping.has(made.principalId)).toBe(false);
    expect(first.orphanedProfiles).toEqual([]);
    tick(FOUNDER_WAIT_MS);
    const report = await mirror.run({ budgetMs: 60_000 });
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
    expect(report.eventsNextHeight).toBe(1);
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
    // The chain's day 25, read first, was swept in the first run.
    expect(db.state?.levels_tdh_day).toBe(25);
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
    expect(second.levelsSwept).toBe(2);
  });

  it('goes on with a level sweep across runs, a page at a time, and starts again for a newer day', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    for (let i = 0; i < 4; i++) {
      const it = leveled(chainIdentity(PID(80 + i), [W(80 + i)]), 100 - i, 25);
      chain.identities.set(it.principalId, it);
    }
    await mirror.run({ budgetMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      const it = chain.identities.get(PID(80 + i))!;
      chain.identities.set(it.principalId, leveled(it, 100 - i, 26));
    }
    chain.identities.set(
      PID(1),
      leveled(chain.identities.get(PID(1))!, 1005, 26)
    );
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

  it('writes a big feed page in part, leaving the rest to retry, and moves on', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    const many = Array.from({ length: 2_001 }, (_, i) =>
      principalRecord(PID(5_000 + i))
    );
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [block(101, many)]
    });
    const report = await mirror.run({ budgetMs: 60 * 60_000 });
    expect(db.state?.next_height).toBe(102);
    expect(report.deferred).toBe(1);
    expect(db.state?.retry.principals).toEqual([PID(7_000)]);
    // Past the run's deadline: the rest is left too.
    chain.feed.push({
      from: 102,
      through: 102,
      next: 103,
      blocks: [
        block(102, [
          principalRecord(PID(1)),
          principalRecord(PID(2)),
          principalRecord(PID(3))
        ])
      ]
    });
    const read = gateway.getIdentityByPrincipal.getMockImplementation()!;
    gateway.getIdentityByPrincipal.mockImplementation(async (...args) => {
      tick(25_000);
      return await read(...args);
    });
    const late = await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(103);
    expect(late.deferred).toBeGreaterThan(0);
    expect(db.state?.retry.principals).toContain(PID(3));
  });

  it('leaves the rest of a page to retry once its pin is old', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        block(101, [
          principalRecord(PID(1)),
          principalRecord(PID(2)),
          principalRecord(PID(3))
        ])
      ]
    });
    const read = gateway.getIdentityByPrincipal.getMockImplementation()!;
    gateway.getIdentityByPrincipal.mockImplementation(async (...args) => {
      tick(5 * 60_000);
      return await read(...args);
    });
    const report = await mirror.run({ budgetMs: 2 * 60 * 60_000 });
    expect(db.state?.next_height).toBe(102);
    // Two identities read in ten minutes; the third, and the wallets, wait.
    expect(report.deferred).toBeGreaterThan(0);
    expect(db.state?.retry.principals).toEqual([PID(3)]);
  });

  it('walks only the chain use cases, resuming the delegations where a run stopped', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    const asked = () =>
      gateway.getDelegations.mock.calls
        .map((it) => (it[0] as { byUseCase?: number }).byUseCase)
        .filter((it) => it !== undefined);
    expect(asked()).toEqual(CHAIN_DELEGATION_USE_CASES);
    expect(db.outsideDeleted).toEqual([CHAIN_DELEGATION_USE_CASES]);
    // A full sync whose run ends after the third use case.
    gateway.getDelegations.mockClear();
    db.state = {
      ...db.state!,
      sync_phase: 'DELEGATIONS',
      sync_from_height: 100,
      sync_use_case: null
    };
    const list = gateway.getDelegations.getMockImplementation()!;
    gateway.getDelegations.mockImplementation(async (...args) => {
      tick(9_000);
      return await list(...args);
    });
    chain.feed.length = 0;
    await mirror.run({ budgetMs: 60_000 });
    const first = asked();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(CHAIN_DELEGATION_USE_CASES.length);
    expect(db.state?.sync_phase).toBe('DELEGATIONS');
    expect(db.state?.sync_use_case).toBe(
      CHAIN_DELEGATION_USE_CASES[first.length]
    );
    gateway.getDelegations.mockClear();
    gateway.getDelegations.mockImplementation(list);
    await mirror.run({ budgetMs: 60_000 });
    expect(asked()[0]).toBe(CHAIN_DELEGATION_USE_CASES[first.length]);
    expect(db.state?.sync_phase).toBeNull();
    expect(db.state?.sync_use_case).toBeNull();
  });

  it('sweeps after a TDH day the chain says began, though the feed is quiet', async () => {
    const { mirror, db, chain, gateway, alice } = world();
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBeNull();
    chain.tdhDay = 26;
    chain.finalized = 130;
    chain.identities.set(alice.principalId, leveled(alice, 3000, 26));
    gateway.getLevelRanking.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state).toMatchObject({
      levels_tdh_day: 26,
      levels_day_height: 130,
      level_sweep_day: null
    });
    expect(gateway.getLevelRanking).toHaveBeenCalled();
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(3000);
  });

  it('sweeps no ranking from before the day, nor a level of an earlier day', async () => {
    const { mirror, db, chain, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    chain.tdhDay = 26;
    chain.finalized = 130;
    // The node ranking is still at 120, from before day 26 began.
    const sweep = (rankedAt: number, day: number) => {
      chain.identities.set(alice.principalId, leveled(alice, 3000, day));
      return rankedAt;
    };
    const rank = gateway.getLevelRanking.getMockImplementation()!;
    gateway.getLevelRanking.mockImplementation(
      async (opts?: { after?: string | null; limit?: number }) => {
        const rankedAt = sweep(120, 26);
        const page = await rank(opts);
        return { ...page, data: { ...page.data, rankedAt } };
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBe(26);
    expect(db.rows.get(`${A}-${B}`)?.level_raw).not.toBe(3000);
    // Ranked after the day began, but its levels are of day 25: not yet.
    gateway.getLevelRanking.mockImplementation(
      async (opts?: { after?: string | null; limit?: number }) => {
        const rankedAt = sweep(130, 25);
        const page = await rank(opts);
        return { ...page, data: { ...page.data, rankedAt } };
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBe(26);
    // Both right: swept.
    gateway.getLevelRanking.mockImplementation(
      async (opts?: { after?: string | null; limit?: number }) => {
        const rankedAt = sweep(130, 26);
        const page = await rank(opts);
        return { ...page, data: { ...page.data, rankedAt } };
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBeNull();
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(3000);
  });

  it('never writes a level older than the one the row has', async () => {
    const { mirror, db, chain, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    // The feed wrote alice's level as of 150.
    db.levelHeights.set(alice.principalId, 150);
    db.rows.set(`${A}-${B}`, { ...db.rows.get(`${A}-${B}`)!, level_raw: 7777 });
    // A sweep ranked at 130 doesn't go over it.
    chain.tdhDay = 26;
    chain.finalized = 130;
    chain.identities.set(alice.principalId, leveled(alice, 3000, 26));
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBeNull();
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(7777);
    // Nor does an identity read at 130.
    db.state = {
      ...db.state!,
      retry: { principals: [alice.principalId], targets: [], wallets: [] }
    };
    await mirror.run({ budgetMs: 60_000 });
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(7777);
    // One read at 160 does, and moves the height on.
    chain.finalized = 160;
    chain.identities.set(alice.principalId, leveled(alice, 3100, 26));
    db.state = {
      ...db.state!,
      retry: { principals: [alice.principalId], targets: [], wallets: [] }
    };
    gateway.getLevelRanking.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(3100);
    expect(db.levelHeights.get(alice.principalId)).toBe(160);
  });

  it('reads a level the ranking leaves out', async () => {
    const { mirror, db, chain, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    chain.tdhDay = 26;
    chain.identities.set(alice.principalId, leveled(alice, 3000, 26));
    const rank = gateway.getLevelRanking.getMockImplementation()!;
    gateway.getLevelRanking.mockImplementation(
      async (opts?: { after?: string | null; limit?: number }) => {
        const page = await rank(opts);
        return {
          ...page,
          data: {
            ...page.data,
            rows: page.data.rows.map((row) => ({
              ...row,
              identity: { ...row.identity, level: null }
            }))
          }
        };
      }
    );
    gateway.getIdentityByPrincipal.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    // Read at the ranking's height, so the level written is as of it.
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledWith(
      alice.principalId,
      { height: 100 }
    );
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(3000);
  });

  it('restarts the delegations from the first use case when a full sync starts again', async () => {
    const { mirror, db, chain, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      sync_phase: 'DELEGATIONS',
      sync_from_height: 100,
      sync_use_case: 5,
      sync_wallet_after: W(1)
    };
    // The feed no longer holds its height: a new full sync.
    const changesOf = gateway.getChanges.getMockImplementation()!;
    gateway.getChanges.mockImplementation(
      async (from: number | string, opts?: { families?: string[] }) => {
        if (!opts?.families && String(from) === '101') {
          throw new ChainGatewayError('gone', 410, 'gone', '/v1/feed');
        }
        return await changesOf(from, opts);
      }
    );
    chain.finalized = 120;
    gateway.getDelegations.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    const asked = gateway.getDelegations.mock.calls
      .map((it) => (it[0] as { byUseCase?: number }).byUseCase)
      .filter((it) => it !== undefined);
    expect(asked[0]).toBe(1);
    expect(asked).toEqual(CHAIN_DELEGATION_USE_CASES);
  });

  it("writes an identity whose document has values 6529.io can't hold, naming them", async () => {
    const { mirror, db, chain, alice, gateway } = world();
    chain.identities.set(alice.principalId, {
      ...alice,
      profile: { version: 1, docCid: 'b-doc', updatedHeight: 50 } as never
    });
    gateway.getProfileDoc.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          fields: {
            classification: 'C'.repeat(300),
            website: 'https://example.com'
          }
        })
      ) as never
    );
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.failed).toEqual([]);
    expect(report.docProblems).toEqual([
      expect.stringContaining('classification')
    ]);
    expect(db.profiles.get(ALICE_PROFILE)?.website).toBe('https://example.com');
    expect(db.profiles.get(ALICE_PROFILE)?.classification).toBeNull();
  });

  it('tries again the keys behind ones that keep failing', async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    const wallets = Array.from({ length: 600 }, (_, i) => W(3_000 + i));
    const failing = new Set(wallets.slice(0, 500));
    const ofWallet = gateway.getDelegationsOfWallet.getMockImplementation()!;
    gateway.getDelegationsOfWallet.mockImplementation(
      async (wallet, ...rest) => {
        if (failing.has(wallet)) throw new Error('timeout');
        return await ofWallet(wallet, ...rest);
      }
    );
    db.state = {
      ...db.state!,
      retry: { principals: [], targets: [], wallets }
    };
    await mirror.run({ budgetMs: 60_000 });
    // The 500 tried first failed and went to the back.
    expect(db.state?.retry.wallets.slice(0, 100)).toEqual(wallets.slice(500));
    gateway.getDelegationsOfWallet.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    const tried = gateway.getDelegationsOfWallet.mock.calls.map((it) => it[0]);
    expect(tried).toEqual(expect.arrayContaining(wallets.slice(500)));
    expect(db.state?.retry.wallets).toHaveLength(500);
  });

  it('settles a merged identity whose founder no history tells, without asking again', async () => {
    const { mirror, db, gateway, chain, tick } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(62), 'p-62');
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(62),
      changes: [],
      ranges: [[5, 100]],
      readHeight: 100
    } as never);
    const merged = chainIdentity(PID(62), [], {
      legacyId: null,
      founder: W(62),
      mergedInto: PID(1)
    });
    await expect(mirror.profileIdForSites(merged)).rejects.toMatchObject({
      reason: 'founder_unknown_yet'
    });
    tick(FOUNDER_WAIT_MS);
    const settled = {
      profileId: principalProfileId(PID(62)),
      imported: false
    };
    expect(await mirror.profileIdForSites(merged)).toEqual(settled);
    // Nothing stored, and the wait kept: later calls settle at once.
    tick(60_000);
    expect(await mirror.profileIdForSites(merged)).toEqual(settled);
    expect(db.founderWaits.has(PID(62))).toBe(true);
    expect(db.mapping.has(PID(62))).toBe(false);
  });

  it('never pins below what an earlier run read', async () => {
    const { mirror, db, chain, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [block(105, [])]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.pin_floor).toBe(105);
    // A full sync from 100, and another node, behind at 102, answers.
    chain.headHeldAt = 102;
    db.state = {
      ...db.state!,
      sync_phase: 'IDENTITIES',
      sync_from_height: 100,
      sync_after: null
    };
    gateway.listIdentities.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.listIdentities).not.toHaveBeenCalled();
    expect(db.state?.sync_phase).toBe('IDENTITIES');
    expect(db.state?.pin_floor).toBe(105);
    chain.headHeldAt = 105;
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.listIdentities).toHaveBeenCalled();
  });

  it('pins a retry batch at the feed place, not below', async () => {
    const { mirror, db, chain, gateway, alice } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      next_height: 106,
      pin_floor: null,
      retry: { principals: [alice.principalId], targets: [], wallets: [] }
    };
    chain.headHeldAt = 104;
    gateway.getIdentityByPrincipal.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    const pinned = () =>
      gateway.getIdentityByPrincipal.mock.calls.filter(
        (it) =>
          ((it as unknown[])[1] as { height?: number } | undefined)?.height !==
          undefined
      );
    expect(pinned()).toEqual([]);
    chain.headHeldAt = 105;
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledWith(
      alice.principalId,
      { height: 105 }
    );
  });

  it("waits for a head at a page's last height", async () => {
    const { mirror, db, chain } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 105,
      next: 106,
      blocks: [block(105, [])]
    });
    chain.headHeldAt = 104;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(101);
    chain.headHeldAt = 105;
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.next_height).toBe(106);
  });

  it('takes a history with no ranges as one that cannot say, not one behind', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(63), 'p-63');
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(63),
      changes: [],
      ranges: [],
      readHeight: 100
    } as never);
    const made = chainIdentity(PID(63), [W(63)], {
      legacyId: null,
      founder: W(63),
      createdHeight: 20
    });
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      reason: 'founder_unknown_yet'
    });
  });

  it('gives no placeholder when the exact bindings passed the creation without the wallet', async () => {
    const { mirror, db, chain, gateway } = world();
    chain.importStart = 1;
    chain.feed.push({ from: 1, through: 30, next: 31, blocks: [] });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state).toMatchObject({
      bindings_exact: true,
      bindings_next_height: 31
    });
    db.placeholders.set(W(64), 'p-64');
    gateway.getMembershipWalletHistory.mockClear();
    const made = chainIdentity(PID(64), [W(64)], {
      legacyId: null,
      founder: W(64),
      createdHeight: 20
    });
    expect(await mirror.profileIdOf(made)).toBe(principalProfileId(PID(64)));
    expect(gateway.getMembershipWalletHistory).not.toHaveBeenCalled();
  });

  it('resumes a use case at the wallet after the last one written', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.delegations.push(
      delegation(W(41), 'wallet', { useCase: 2 }),
      delegation(W(42), 'wallet', { useCase: 2 }),
      delegation(W(43), 'wallet', { useCase: 2 })
    );
    db.state = {
      ...db.state!,
      sync_phase: 'DELEGATIONS',
      sync_from_height: 100,
      sync_use_case: 2,
      sync_wallet_after: null
    };
    const written: string[] = [];
    const replace = db.replaceWalletDelegations.bind(db);
    jest
      .spyOn(db, 'replaceWalletDelegations')
      .mockImplementation(async (wallet, rows, conn, useCase) => {
        written.push(`${useCase}:${wallet}`);
        tick(20_000);
        return await replace(wallet, rows, conn, useCase);
      });
    const sorted = [A, B, W(41), W(42), W(43)].sort();
    // Each write takes 20 s of the run's minute.
    await mirror.run({ budgetMs: 60_000 });
    const first = written.filter((it) => it.startsWith('2:'));
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(sorted.length);
    expect(db.state).toMatchObject({
      sync_use_case: 2,
      sync_wallet_after: sorted[first.length - 1]
    });
    written.length = 0;
    await mirror.run({ budgetMs: 60_000 });
    expect(written[0]).toBe(`2:${sorted[first.length]}`);
  });

  it('takes the help bot credits and xTDH out of rows no chain identity holds, once a full sync ends', async () => {
    const { mirror, db } = world();
    // A 6529.io profile not on the chain: REP 7 with 5 of help-bot credits,
    // CIC 2, a level with 30 of xTDH in it.
    const credit = (category: string, rating: number) => ({
      rater_profile_id: 'some-rater',
      matter: 'REP' as const,
      matter_category: category,
      rating
    });
    db.ratings.set('not-on-chain', [
      credit(' help6529 CREDITS ', 5),
      credit('Kind', 2)
    ]);
    db.rows.set(W(71), {
      ...db.rows.get(`${A}-${B}`)!,
      consolidation_key: W(71),
      profile_id: 'off-chain-uncredited',
      tdh: 10,
      rep: 3,
      cic: 1,
      level_raw: 13
    });
    db.rows.set(W(70), {
      consolidation_key: W(70),
      profile_id: 'not-on-chain',
      primary_address: W(70),
      handle: `id-${W(70)}`,
      normalised_handle: `id-${W(70)}`,
      tdh: 40,
      rep: 7,
      cic: 2,
      level_raw: 77,
      pfp: null,
      banner1: null,
      banner2: null,
      classification: null,
      sub_classification: null,
      xtdh: 30,
      produced_xtdh: 0,
      granted_xtdh: 0,
      xtdh_rate: 0,
      basetdh_rate: 0
    });
    await mirror.run({ budgetMs: 60_000 });
    // REP without the credits, CIC kept, level REP + TDH.
    expect(db.rows.get(W(70))).toMatchObject({ rep: 2, cic: 2, level_raw: 42 });
    // A row without credits keeps its REP and level.
    expect(db.rows.get(W(71))).toMatchObject({ rep: 3, cic: 1, level_raw: 13 });
    // After the first run's level sweep (levels only), then the full sync.
    expect(db.fixes).toEqual([
      { repToo: false, leaveOut: [] },
      { repToo: true, leaveOut: [] }
    ]);
  });

  it('leaves out of the off-chain rewrite the ids of identities waiting to be retried', async () => {
    const { mirror, db, bob } = world();
    const apply = db.applyIdentityPlan.bind(db);
    jest
      .spyOn(db, 'applyIdentityPlan')
      .mockImplementation(async (plan: IdentityPlan) => {
        if (plan.profile.handle === 'bob') throw new Error('deadlock');
        return apply(plan);
      });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.retry.principals).toEqual([bob.principalId]);
    // Bob's possible ids are left out, the others' rows fixed.
    expect(db.fixes).toContainEqual({
      repToo: true,
      leaveOut: expect.arrayContaining([principalProfileId(bob.principalId)])
    });
  });

  it("writes the levels of a relaunched chain over the old one's heights", async () => {
    process.env[RELAUNCH_ALLOWED_ENV] = 'true';
    const { mirror, db, chain, alice } = world();
    chain.network = '0x' + 'aa'.repeat(32);
    await mirror.run({ budgetMs: 60_000 });
    // Alice's level was written as of 500 on the old chain.
    db.levelHeights.set(alice.principalId, 500);
    chain.network = '0x' + 'bb'.repeat(32);
    chain.identities.set(alice.principalId, leveled(alice, 4444, 25));
    await mirror.run({ budgetMs: 60_000 });
    expect(db.rows.get(`${A}-${B}`)?.level_raw).toBe(4444);
    expect(db.levelHeights.get(alice.principalId)).toBe(100);
  });

  it('takes a holder identity off the retry list once its wallets are synced', async () => {
    const { mirror, db, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.state = {
      ...db.state!,
      retry: { principals: [], targets: [], wallets: [alice.principalId] }
    };
    const ofWallet = gateway.getDelegationsOfWallet.getMockImplementation()!;
    gateway.getDelegationsOfWallet.mockImplementation(
      async (wallet, ...rest) => {
        if (wallet === B) throw new Error('timeout');
        return await ofWallet(wallet, ...rest);
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    // The holder is done once read; B failed and is tried again itself.
    expect(db.state?.retry.wallets).toEqual([B]);
    gateway.getDelegationsOfWallet.mockImplementation(ofWallet);
    await mirror.run({ budgetMs: 60_000 });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.retry.wallets).toEqual([]);
  });

  it('waits for bindings that stop at the creation height itself', async () => {
    const { mirror, db, chain } = world();
    chain.importStart = 1;
    chain.feed.push({ from: 1, through: 19, next: 20, blocks: [] });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state).toMatchObject({
      bindings_exact: true,
      bindings_next_height: 20
    });
    db.placeholders.set(W(65), 'p-65');
    const made = chainIdentity(PID(65), [W(65)], {
      legacyId: null,
      founder: W(65),
      createdHeight: 20
    });
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      retryLater: true,
      reason: 'bindings_behind'
    });
  });

  it('fixes the levels of rows off the chain after each level sweep', async () => {
    const { mirror, db, chain, alice } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.fixes = [];
    chain.tdhDay = 26;
    chain.identities.set(alice.principalId, leveled(alice, 1005, 26));
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.level_sweep_day).toBeNull();
    expect(db.fixes).toEqual([{ repToo: false, leaveOut: [] }]);
  });

  it("records the height a sweep page was read at, not only the ranking's", async () => {
    const { mirror, db, chain, alice, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.tdhDay = 26;
    chain.identities.set(alice.principalId, leveled(alice, 3000, 26));
    const rank = gateway.getLevelRanking.getMockImplementation()!;
    gateway.getLevelRanking.mockImplementation(
      async (opts?: { after?: string | null; limit?: number }) => {
        const page = await rank(opts);
        return { ...page, read: { height: 112 } as never };
      }
    );
    await mirror.run({ budgetMs: 60_000 });
    expect(db.levelHeights.get(alice.principalId)).toBe(112);
  });

  it('stops a full sync page at the deadline, going on from the identity after', async () => {
    const { mirror, db, chain, gateway, tick } = world();
    for (let i = 0; i < 4; i++) {
      chain.identities.set(
        PID(30 + i),
        chainIdentity(PID(30 + i), [W(30 + i)])
      );
    }
    const list = gateway.listIdentities.getMockImplementation()!;
    // Pages of the six identities at once.
    gateway.listIdentities.mockImplementation(
      async (opts: { after?: string | null }) => {
        const all = Array.from(chain.identities.values()).sort((a, b) =>
          a.principalId < b.principalId ? -1 : 1
        );
        const start = opts.after
          ? all.findIndex((it) => it.principalId === opts.after) + 1
          : 0;
        return {
          items: all.slice(start),
          next: null,
          read: {} as never
        };
      }
    );
    const apply = db.applyIdentityPlan.bind(db);
    jest
      .spyOn(db, 'applyIdentityPlan')
      .mockImplementation(async (plan: IdentityPlan) => {
        tick(20_000);
        return apply(plan);
      });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.sync_phase).toBe('IDENTITIES');
    const after = db.state?.sync_after;
    expect(after).not.toBeNull();
    gateway.listIdentities.mockClear();
    await mirror.run({ budgetMs: 60_000 });
    expect(gateway.listIdentities.mock.calls[0][0]).toMatchObject({ after });
    gateway.listIdentities.mockImplementation(list);
  });

  it("maps an identity later when this node doesn't hold the import", async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    gateway.getImportedIdentity.mockRejectedValueOnce(
      new ChainGatewayError('not here', 404, 'not_held', '/v1/identities')
    );
    const old = chainIdentity(PID(52), [W(52)]);
    await expect(mirror.profileIdOf(old)).rejects.toMatchObject({
      retryLater: true,
      reason: 'not_held'
    });
    expect(db.mapping.has(PID(52))).toBe(false);
  });

  it("waits on a founder whose wallet history this node doesn't hold", async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(53), 'p-53');
    gateway.getMembershipWalletHistory.mockRejectedValueOnce(
      new ChainGatewayError('not here', 404, 'not_held', '/v1/membership')
    );
    const made = chainIdentity(PID(53), [W(53)], {
      legacyId: null,
      founder: W(53),
      createdHeight: 20
    });
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      retryLater: true,
      reason: 'not_held'
    });
  });

  it("goes on when this node doesn't hold the TDH day", async () => {
    const { mirror, db, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    gateway.getTdh.mockRejectedValue(
      new ChainGatewayError('not here', 404, 'not_held', '/v1/tdh')
    );
    gateway.getLevelRanking.mockClear();
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBeUndefined();
    expect(gateway.getLevelRanking).not.toHaveBeenCalled();
    expect(db.state?.next_height).toBe(101);
  });

  it("can't say from a history whose first range ends before a read past the creation", async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(54), 'p-54');
    // Held from the import to 50, read at 200: a gap before 80.
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(54),
      changes: [],
      ranges: [[1, 50]],
      readHeight: 200
    } as never);
    const made = chainIdentity(PID(54), [W(54)], {
      legacyId: null,
      founder: W(54),
      createdHeight: 80
    });
    await expect(mirror.profileIdOf(made)).rejects.toMatchObject({
      reason: 'founder_unknown_yet'
    });
    expect(db.founderWaits.has(PID(54))).toBe(true);
  });

  it("reads an identity again when its primary's delegation changes", () => {
    const effects = feedEffects([
      {
        family: '0x0121',
        name: 'Delegation',
        key: '0x',
        value: null,
        keyFields: { holder: PID(7), useCase: 997 },
        valueFields: { delegate: W(9) }
      },
      {
        family: '0x0121',
        name: 'Delegation',
        key: '0x',
        value: null,
        keyFields: { holder: PID(8), useCase: 2 },
        valueFields: { delegate: W(9) }
      },
      {
        family: '0x0301',
        name: 'RaterBudget',
        key: '0x',
        value: null,
        keyFields: { rater: PID(6) },
        valueFields: null
      }
    ]);
    expect(Array.from(effects.principals)).toEqual([PID(7)]);
    expect(Array.from(effects.delegationHolders).sort()).toEqual(
      [PID(7), PID(8), W(9)].sort()
    );
    expect(effects.ratingTargets.size).toBe(0);
  });

  it("goes on with a page when its wallets' identities can't be read", async () => {
    const { mirror, db, chain, alice, bob, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    // Bob's wallet C joins Alice; Bob, left without one, isn't written.
    chain.identities.set(alice.principalId, { ...alice, wallets: [A, B, C] });
    chain.identities.delete(bob.principalId);
    chain.feed.push({
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
    });
    gateway.getIdentitiesByWallets.mockRejectedValueOnce(new Error('timeout'));
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBeUndefined();
    expect(db.state?.next_height).toBe(102);
    // The record names Alice: she is written with C.
    expect(db.addressKeys.get(C)).toBe([A, B, C].join('-'));
    expect(report.failed).toEqual(['wallets of the page: timeout']);
  });

  it("puts a key whose identity can't be read on the retry list, and goes on", async () => {
    const { mirror, db, chain, alice, bob, gateway } = world();
    await mirror.run({ budgetMs: 60_000 });
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [
        block(101, [
          principalRecord(alice.principalId),
          principalRecord(bob.principalId)
        ])
      ]
    });
    const read = gateway.getIdentityByPrincipal.getMockImplementation()!;
    gateway.getIdentityByPrincipal.mockImplementation(async (p: string) => {
      if (p === alice.principalId) throw new Error('timeout');
      return await read(p);
    });
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.error).toBeUndefined();
    expect(db.state?.next_height).toBe(102);
    expect(db.state?.retry.principals).toEqual([alice.principalId]);
  });

  it('runs the levels of rows off the chain a step each run, from where it got to', async () => {
    const { mirror, db } = world();
    await mirror.run({ budgetMs: 60_000 });
    db.levelSteps = [];
    db.state = { ...db.state!, off_chain_after: W(5) };
    await mirror.run({ budgetMs: 60_000 });
    expect(db.levelSteps).toEqual([{ after: W(5), leaveOut: [] }]);
    // At the end, the next run starts from the top.
    expect(db.state?.off_chain_after).toBeNull();
    await mirror.run({ budgetMs: 60_000 });
    expect(db.levelSteps[1]).toEqual({ after: '', leaveOut: [] });
  });

  it('files a merged identity under the id once decided, whatever a later node says', async () => {
    const { mirror, db, gateway, chain, tick } = world();
    chain.importStart = 1;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(66), 'p-66');
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(66),
      changes: [],
      ranges: [[5, 100]],
      readHeight: 100
    } as never);
    const merged = chainIdentity(PID(66), [], {
      legacyId: null,
      founder: W(66),
      createdHeight: 20,
      mergedInto: PID(1)
    });
    await expect(mirror.profileIdForSites(merged)).rejects.toMatchObject({
      reason: 'founder_unknown_yet'
    });
    tick(FOUNDER_WAIT_MS);
    const derived = principalProfileId(PID(66));
    expect((await mirror.profileIdForSites(merged)).profileId).toBe(derived);
    // A node with the whole history would say it was the founder's first.
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W(66),
      changes: [{ height: 20, principalId: PID(66) }],
      ranges: [[1, 100]],
      readHeight: 100
    } as never);
    expect((await mirror.profileIdForSites(merged)).profileId).toBe(derived);
    expect(db.mapping.has(PID(66))).toBe(false);
  });

  it('counts a wallet history from the import, as the client is told', async () => {
    const { mirror, db, gateway, chain } = world();
    chain.importStart = 7;
    await mirror.run({ budgetMs: 60_000 });
    historyDecides(db);
    db.placeholders.set(W(67), 'p-67');
    gateway.getMembershipWalletHistory.mockClear();
    const made = chainIdentity(PID(67), [W(67)], {
      legacyId: null,
      founder: W(67),
      createdHeight: 3
    });
    await mirror.profileIdOf(made).catch(() => undefined);
    expect(gateway.getMembershipWalletHistory).toHaveBeenCalledWith(W(67), {
      noBindingsBefore: 7
    });
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

  it('runs no profile site follower before the first full sync ends, and does during a later one', async () => {
    const calls: unknown[] = [];
    const { mirror, db, gateway } = world([
      async (port) => {
        calls.push(port);
      }
    ]);
    gateway.listIdentities.mockRejectedValueOnce(new Error('timeout'));
    await mirror.run({ budgetMs: 60_000 });
    expect(db.state?.last_full_sync_at).toBeNull();
    expect(await mirror.followProfileSites()).toEqual([]);
    expect(calls).toHaveLength(0);
    await mirror.run({ budgetMs: 60_000 });
    db.state = { ...db.state!, sync_phase: 'DELEGATIONS' };
    expect(await mirror.followProfileSites()).toEqual([]);
    expect(calls).toHaveLength(1);
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
    // An imported one is mapped to its own profile all the same, so its
    // row isn't taken for a profile off the chain.
    const wide = Array.from({ length: 5 }, (_, i) => W(110 + i));
    chain.identities.set(
      PID(10),
      chainIdentity(PID(10), wide, { legacyId: 'p-wide' })
    );
    const report = await mirror.run({ budgetMs: 60_000 });
    expect(report.skippedTooManyWallets).toEqual([PID(9), PID(10)]);
    expect(Array.from(db.addressKeys.keys())).not.toContain(many[0]);
    expect(db.mapping.get(PID(10))?.profile).toBe('p-wide');
    // Also when only the feed names it (not as a rating target).
    const wider = Array.from({ length: 5 }, (_, i) => W(120 + i));
    chain.identities.set(
      PID(11),
      chainIdentity(PID(11), wider, { legacyId: 'p-wide-2' })
    );
    chain.feed.push({
      from: 101,
      through: 101,
      next: 102,
      blocks: [block(101, [principalRecord(PID(11))])]
    });
    await mirror.run({ budgetMs: 60_000 });
    expect(db.mapping.get(PID(11))?.profile).toBe('p-wide-2');
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
    // A rating's target is refreshed (its totals moved); its rater isn't.
    expect(Array.from(effects.principals).sort()).toEqual([PID(1), PID(3)]);
    expect(Array.from(effects.wallets)).toEqual([A]);
    expect(Array.from(effects.ratingTargets)).toEqual([PID(3)]);
    // Without a field naming the target, every principal it names.
    const unnamed = feedEffects([
      {
        family: '0x0701',
        name: 'Rating',
        key: '0x',
        value: null,
        keyFields: { rater: PID(2), principal: PID(4) },
        valueFields: null
      }
    ]);
    expect(Array.from(unnamed.ratingTargets).sort()).toEqual([PID(2), PID(4)]);
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
