import {
  ChainGatewayClient,
  ChainGatewayError,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainDelegation,
  ChainFeedRecord,
  ChainIdentity,
  ChainRating
} from '@/chain-gateway/chain-gateway.types';
import { isHelpBotCreditCategory } from '@/help-bot/help-bot.config';
import { Logger } from '@/logging';
import { ConnectionWrapper } from '@/sql-executor';
import {
  DelegationRowWrite,
  identityChainMirrorDb,
  IdentityChainMirrorDb,
  MirrorState,
  numberOrNull,
  RatingEventContext,
  RatingRowWrite
} from './identity-chain-mirror.db';
import {
  CHAIN_BLOCK_BASE,
  ChainIdentityView,
  consolidationKeyOf,
  membershipChangeOf,
  NEVER_EXPIRES,
  planIdentity,
  principalProfileId
} from './identity-plan';
import {
  MEMBERSHIP_CHANGE_HANDLERS,
  MembershipChange,
  MembershipChangeHandler
} from './membership-change';
import {
  GatewayProfileSitePort,
  ProfileSiteFollower
} from './profile-site-port';
import { IdentityChainLookups } from './identity-chain-lookups';
import {
  ADDRESS_BINDING_FAMILY,
  BindingPage,
  bindingChangesOf,
  foldBindings,
  WalletBindingRow
} from './wallet-bindings';
import { toDelegationRow } from './delegation-rows';
import {
  decodeProfileDoc,
  ProfileDocFields,
  toProfileDocFields
} from './profile-doc';

const logger = Logger.get('IDENTITY_CHAIN_MIRROR');

/**
 * 6529.io's consolidation keys held four wallets (varchar 200) before the
 * widening migration; the mirror reads the live width at each run and falls
 * back to this.
 */
export const MAX_CONSOLIDATION_KEY_LENGTH = 200;
const FULL_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const FEED_PAGE_BLOCKS = 200;
const IDENTITY_PAGE = 200;
const LAST_USE_CASE = 998;
const FEED_GONE_ATTEMPTS = 3;
/** ratings.rating is a signed 32-bit int. */
const MAX_RATING = 2_147_483_647;

/**
 * Called by `followProfileSites()`, which the delegations loop runs as its
 * last step, with the profile site index's chain reads; each follows the
 * chain from its own cursor. The profile site index adds its
 * `followProfileCmsChanges` here.
 */
export const PROFILE_SITE_FOLLOWERS: readonly ProfileSiteFollower[] = [];

/** The wallet bindings take at most this share of a run's budget. */
const BINDINGS_SHARE = 0.5;

type Gateway = Pick<
  ChainGatewayClient,
  | 'getHead'
  | 'getMembership'
  | 'listMembershipWallets'
  | 'getMembershipWalletHistory'
  | 'getImportedIdentity'
  | 'getDocument'
  | 'putDocument'
  | 'listIdentities'
  | 'getIdentityByPrincipal'
  | 'getIdentitiesByWallets'
  | 'getIdentityByLegacyProfileId'
  | 'getProfileDoc'
  | 'getRatings'
  | 'getDelegations'
  | 'getDelegationsOfWallet'
  | 'getChanges'
>;

export interface MirrorRunReport {
  skipped?: 'import_not_complete';
  mode: 'full_sync' | 'feed' | 'idle';
  identities: number;
  ratingTargets: number;
  delegationWallets: number;
  feedBlocks: number;
  skippedTooManyWallets: string[];
  /** Merged, closing or walletless identities, not written. */
  skippedInactive: string[];
  /** Identities that failed, with why; the rest went on. */
  failed: string[];
  /** Wallets whose consolidation key changed: re-keyed by the caller. */
  regroupedWallets: string[];
  /** Placeholder profiles whose wallets all joined an identity. */
  orphanedProfiles: string[];
  /** AddressBinding changes applied to the wallet bindings. */
  walletBindings: number;
  /** AddressBinding records that could not be read (height:key). */
  bindingProblems: string[];
  /** Where the wallet bindings stopped: the next feed height they read. */
  bindingsNextHeight: number | null;
  docProblems: string[];
  nextHeight: number | null;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX20 = /^0x[0-9a-f]{40}$/;
/** A 32-byte word holding an address: 12 zero bytes, then the address. */
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/;
const PRINCIPAL_FIELD = /principal|rater|target|holder|identity|merged|^p$/i;

function collectHex(
  fields: Record<string, unknown> | null | undefined,
  principals: Set<string>,
  wallets: Set<string>,
  anyHex32: Set<string>
) {
  if (!fields) return;
  for (const [name, raw] of Object.entries(fields)) {
    if (typeof raw !== 'string') continue;
    const value = raw.toLowerCase();
    const word = ADDRESS_WORD.exec(value);
    if (word) {
      wallets.add(`0x${word[1]}`);
    } else if (HEX32.test(value)) {
      anyHex32.add(value);
      if (PRINCIPAL_FIELD.test(name)) principals.add(value);
    } else if (HEX20.test(value)) {
      wallets.add(value);
    }
  }
}

/** Where the mirror is reading: the height and how it got there. */
export interface MirrorAt {
  readonly height: number;
  readonly source: RatingEventContext['source'];
}

export interface FeedEffects {
  readonly principals: Set<string>;
  readonly wallets: Set<string>;
  readonly ratingTargets: Set<string>;
  readonly delegationHolders: Set<string>;
}

/**
 * What a page of the change feed touches. Records are read generically:
 * 32-byte ids in principal-like fields are identities, 20-byte values are
 * wallets; rating families mark their principals for a ratings refresh,
 * delegation families their holders for a delegations refresh.
 */
export function feedEffects(records: readonly ChainFeedRecord[]): FeedEffects {
  const effects: FeedEffects = {
    principals: new Set(),
    wallets: new Set(),
    ratingTargets: new Set(),
    delegationHolders: new Set()
  };
  for (const record of records) {
    const principals = new Set<string>();
    const wallets = new Set<string>();
    const anyHex32 = new Set<string>();
    collectHex(record.keyFields, principals, wallets, anyHex32);
    collectHex(record.valueFields ?? undefined, principals, wallets, anyHex32);
    const ids = principals.size ? principals : anyHex32;
    const name = `${record.name ?? ''}`;
    if (/rating/i.test(name)) {
      // A rating moves its target's totals and level too.
      ids.forEach((it) => {
        effects.ratingTargets.add(it);
        effects.principals.add(it);
      });
    } else if (/delegation/i.test(name)) {
      ids.forEach((it) => effects.delegationHolders.add(it));
      wallets.forEach((it) => effects.delegationHolders.add(it));
    } else {
      ids.forEach((it) => effects.principals.add(it));
      wallets.forEach((it) => effects.wallets.add(it));
    }
  }
  return effects;
}

/** Merged, closing or walletless: nothing of it is written. */
export function isInactive(identity: ChainIdentity): boolean {
  return (
    !!identity.mergedInto ||
    !identity.wallets.length ||
    (!!identity.status && identity.status.toLowerCase() !== 'active')
  );
}

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The identity mirror: keeps 6529.io's identity tables (profiles,
 * identities, address_consolidation_keys, consolidations as confirmed pairs,
 * delegations, REP and CIC ratings, statements, and the rep/cic/level_raw
 * aggregates) equal to the 6529 chain, read through the gateway at finalized
 * heights. A full sync walks every identity, delegation and pair; between
 * full syncs it follows the gateway's change feed. It writes what the chain
 * says, so a run may repeat another's work safely. Runs must not overlap
 * (the delegations loop runs one at a time): the wallet bindings follow the
 * feed in order.
 */
export class IdentityChainMirror {
  private readonly identities = new Map<string, ChainIdentity | null>();
  private keyWidth = MAX_CONSOLIDATION_KEY_LENGTH;

  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly db: IdentityChainMirrorDb = identityChainMirrorDb,
    private readonly now: () => number = () => Date.now(),
    private readonly membershipHandlers: readonly MembershipChangeHandler[] = MEMBERSHIP_CHANGE_HANDLERS,
    private readonly profileSiteFollowers: readonly ProfileSiteFollower[] = PROFILE_SITE_FOLLOWERS
  ) {}

  /** The profile site index's chain reads, with this mirror's profile ids. */
  profileSitePort(): GatewayProfileSitePort {
    const lookups = new IdentityChainLookups(this.db, this.gateway);
    return new GatewayProfileSitePort(
      this.gateway,
      (identity) => this.profileIdForSites(identity),
      (wallet, height) => lookups.walletPrincipalAt(wallet, height)
    );
  }

  /**
   * The profile id the profile site index files an identity under: the
   * mirror's own (mapped now if needed) for an identity the mirror writes;
   * for a merged or closed one, its mapping if it has one, else its legacy
   * id, else the id derived from its principal, with nothing stored.
   */
  async profileIdForSites(identity: ChainIdentity): Promise<string> {
    if (!isInactive(identity)) return await this.profileIdOf(identity);
    const principal = identity.principalId.toLowerCase();
    return (
      (await this.db.profileIdOfPrincipal(principal)) ??
      identity.legacyId?.toLowerCase() ??
      principalProfileId(principal)
    );
  }

  private report(): MirrorRunReport {
    return {
      mode: 'idle',
      identities: 0,
      ratingTargets: 0,
      delegationWallets: 0,
      feedBlocks: 0,
      skippedTooManyWallets: [],
      docProblems: [],
      skippedInactive: [],
      failed: [],
      regroupedWallets: [],
      orphanedProfiles: [],
      walletBindings: 0,
      bindingProblems: [],
      bindingsNextHeight: null,
      nextHeight: null
    };
  }

  async run({ budgetMs }: { budgetMs: number }): Promise<MirrorRunReport> {
    const deadline = this.now() + budgetMs;
    const report = this.report();
    this.identities.clear();
    const membership = await this.gateway.getMembership();
    const importState = membership?.import as
      | {
          completed?: boolean;
          startHeight?: number | null;
          fileHash?: string | null;
        }
      | undefined;
    if (!importState?.completed) {
      report.skipped = 'import_not_complete';
      return report;
    }
    this.keyWidth =
      (await this.db.consolidationKeyWidth()) ?? MAX_CONSOLIDATION_KEY_LENGTH;
    let state = (await this.db.getState()) ?? this.emptyState();
    state = await this.followBindings(
      state,
      {
        startHeight: numberOrNull(importState.startHeight),
        fileHash: importState.fileHash?.toLowerCase() ?? null
      },
      Math.min(deadline, this.now() + budgetMs * BINDINGS_SHARE),
      report
    );
    report.bindingsNextHeight = state.bindings_next_height;
    state = await this.syncIdentities(state, deadline, report);
    report.nextHeight = state.next_height;
    return report;
  }

  /** The identity tables: a full sync when due, else the change feed. */
  private async syncIdentities(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    const fullSyncDue =
      state.last_full_sync_at === null ||
      this.now() - Number(state.last_full_sync_at) > FULL_SYNC_EVERY_MS;
    if (!state.sync_phase && (state.next_height === null || fullSyncDue)) {
      state = await this.startFullSync(state);
    }
    if (state.sync_phase) {
      report.mode = 'full_sync';
      state = await this.continueFullSync(state, deadline, report);
    }
    if (!state.sync_phase && state.next_height !== null) {
      if (report.mode === 'idle') report.mode = 'feed';
      state = await this.followFeed(state, deadline, report);
    }
    return state;
  }

  private emptyState(): MirrorState {
    return {
      next_height: null,
      sync_from_height: null,
      sync_phase: null,
      sync_after: null,
      last_full_sync_at: null,
      bindings_next_height: null,
      bindings_chain: null
    };
  }

  private async save(state: MirrorState): Promise<MirrorState> {
    await this.db.saveState(state, this.now());
    return state;
  }

  // ---------------------------------------------------------------- full sync

  private async startFullSync(state: MirrorState): Promise<MirrorState> {
    const head = await this.gateway.getHead(true);
    logger.info(`[FULL SYNC FROM HEIGHT ${head.finalizedHeight}]`);
    return await this.save({
      ...state,
      sync_from_height: head.finalizedHeight,
      sync_phase: 'IDENTITIES',
      sync_after: null
    });
  }

  // ---------------------------------------------------------------- wallet bindings

  /**
   * The wallet bindings follow the feed's AddressBinding records with their
   * own cursor, from the import's first block. Rows are written before the
   * cursor moves, so the table is never behind the height it claims (rows
   * ahead of it only send a lookup to the chain). They start again, empty,
   * when read from another chain or when the cursor is past the chain's
   * finalized height (a relaunch). When the gateway no longer holds the
   * cursor's height, or the import's start is unknown, they are rebuilt from
   * the membership list. A failure here is reported and the identity tables
   * go on.
   */
  private async followBindings(
    initial: MirrorState,
    chain: { startHeight: number | null; fileHash: string | null },
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    try {
      state = await this.bindingsOfThisChain(state, chain.fileHash);
      if (state.bindings_next_height !== null) {
        return await this.readBindings(state, deadline, report);
      }
      if (chain.startHeight === null) {
        return await this.rebuildBindings(state, report);
      }
      // Lookups trust no row without a cursor: start from an empty table.
      const start = { ...state, bindings_next_height: chain.startHeight };
      await this.db.executeNativeQueriesInTransaction(async (conn) => {
        await this.db.clearWalletBindings(conn);
        await this.db.saveState(start, this.now(), conn);
      });
      return await this.readBindings(start, deadline, report);
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[WALLET BINDINGS FAILED] ${message}`);
      report.bindingProblems.push(message);
      return (await this.db.getState()) ?? state;
    }
  }

  /**
   * The bindings' state, started again when they were read from another
   * chain: its network id (or, from a gateway that doesn't give one, its
   * import file's hash) differs.
   */
  private async bindingsOfThisChain(
    state: MirrorState,
    fileHash: string | null
  ): Promise<MirrorState> {
    const network = (await this.gateway.getHead(true)).network;
    const chain = network?.toLowerCase() ?? fileHash;
    if (state.bindings_chain !== null && state.bindings_chain !== chain) {
      logger.warn(
        `[WALLET BINDINGS OF ANOTHER CHAIN] [${state.bindings_chain}] [NOW ${chain}] [STARTING AGAIN]`
      );
      return await this.save({
        ...state,
        bindings_next_height: null,
        bindings_chain: chain
      });
    }
    return state.bindings_chain === chain
      ? state
      : await this.save({ ...state, bindings_chain: chain });
  }

  /** Pages of the feed's binding records from the cursor, to the deadline. */
  private async readBindings(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    let from = Number(state.bindings_next_height);
    while (this.now() < deadline) {
      const page = await this.feedPage(from, true);
      if (!page) {
        logger.warn(
          `[BINDINGS: FEED GONE AT ${from}] [LISTING THE MEMBERSHIP]`
        );
        return await this.rebuildBindings(state, report);
      }
      if (page.through < page.from || page.next <= from) break;
      const read = bindingChangesOf(page.blocks);
      const next = read.stoppedAt ?? page.next;
      state = await this.applyBindingPage(
        read,
        { ...state, bindings_next_height: next },
        report
      );
      if (read.stoppedAt !== null) break;
      from = next;
    }
    return state;
  }

  /**
   * A page of binding changes onto the stored bindings, and the cursor
   * past it, in one transaction.
   */
  private async applyBindingPage(
    page: BindingPage,
    next: MirrorState,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    if (page.malformed.length) {
      logger.error(
        `[UNREADABLE ADDRESS BINDINGS] ${page.malformed.join(', ')}`
      );
      report.bindingProblems.push(...page.malformed);
    }
    const wallets = Array.from(new Set(page.changes.map((it) => it.wallet)));
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      if (wallets.length) {
        const stored = await this.db.walletBindings(wallets, conn);
        const { upserts, deletes } = foldBindings(stored, page.changes);
        await this.db.writeWalletBindings(upserts, deletes, this.now(), conn);
      }
      await this.db.saveState(next, this.now(), conn);
    });
    report.walletBindings += page.changes.length;
    return next;
  }

  /**
   * Without the feed for some heights, nothing says when a wallet was bound
   * (it may have left and come back in the gap), so every bound wallet, as
   * one membership list pinned at the finalized height shows it, is stored
   * as bound since that height: later than the truth, never earlier. For an
   * earlier height a lookup asks the chain's history. Unlisted rows go, and
   * the bindings follow the feed from the next height. A list the gateway
   * can't give at one height is tried again next run.
   */
  private async rebuildBindings(
    state: MirrorState,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    const height = (await this.gateway.getHead(true)).finalizedHeight;
    const bound = await this.membershipAt(height);
    if (!bound) {
      logger.warn(`[BINDINGS: NO MEMBERSHIP LIST AT ${height}] [NEXT RUN]`);
      return state;
    }
    const upserts: WalletBindingRow[] = Array.from(bound.entries()).map(
      ([wallet, principal]) => ({
        wallet,
        principal_id: principal,
        bound_from_height: height
      })
    );
    const next = { ...state, bindings_next_height: height + 1 };
    const removed = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        const deletes = (await this.db.boundWallets(conn)).filter(
          (it) => !bound.has(it)
        );
        await this.db.writeWalletBindings(upserts, deletes, this.now(), conn);
        await this.db.saveState(next, this.now(), conn);
        return deletes.length;
      }
    );
    logger.info(
      `[BINDINGS REBUILT AT ${height}] [${upserts.length} BOUND] [${removed} REMOVED]`
    );
    report.walletBindings += upserts.length + removed;
    return next;
  }

  /** Every bound wallet at `height`, or null when not all of it reads there. */
  private async membershipAt(
    height: number
  ): Promise<Map<string, string> | null> {
    const bound = new Map<string, string>();
    let after: string | null = null;
    try {
      for (;;) {
        const page = await this.gateway.listMembershipWallets({
          after,
          limit: 5000,
          height
        });
        if (!page || Number(page.read?.height) !== height) return null;
        for (const item of page.items) {
          if (item.principalId) {
            bound.set(
              item.wallet.toLowerCase(),
              item.principalId.toLowerCase()
            );
          }
        }
        if (!page.next) return bound;
        after = page.next;
      }
    } catch (error) {
      if (error instanceof ChainGatewayError && error.code === 'height_gone') {
        return null;
      }
      throw error;
    }
  }

  private async continueFullSync(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    while (state.sync_phase === 'IDENTITIES' && this.now() < deadline) {
      const page = await this.gateway.listIdentities({
        after: state.sync_after,
        limit: IDENTITY_PAGE
      });
      const at: MirrorAt = {
        height: Number(state.sync_from_height),
        source: 'FULL_SYNC'
      };
      for (const identity of page?.items ?? []) {
        await this.isolated(identity.principalId, report, async () => {
          await this.applyIdentity(identity, report, at);
          await this.syncTargetRatings(identity, report, at);
        });
      }
      state = await this.save(
        page?.next
          ? { ...state, sync_after: page.next }
          : { ...state, sync_phase: 'DELEGATIONS', sync_after: null }
      );
    }
    if (state.sync_phase === 'DELEGATIONS' && this.now() < deadline) {
      await this.fullSyncDelegations(report);
      state = await this.save({ ...state, sync_phase: 'CONSOLIDATIONS' });
    }
    if (state.sync_phase === 'CONSOLIDATIONS' && this.now() < deadline) {
      await this.fullSyncPairs(state);
      state = await this.save({
        ...state,
        next_height: Number(state.sync_from_height) + 1,
        sync_from_height: null,
        sync_phase: null,
        sync_after: null,
        last_full_sync_at: this.now()
      });
      logger.info(`[FULL SYNC DONE] [NEXT HEIGHT ${state.next_height}]`);
    }
    return state;
  }

  /**
   * Each profile site follower, once the identity tables are past a full
   * sync; the delegations loop runs this last. A failure is logged and
   * returned; the others go on.
   */
  async followProfileSites(notAfter?: number): Promise<string[]> {
    const problems: string[] = [];
    if (!this.profileSiteFollowers.length) return problems;
    if (notAfter !== undefined && this.now() > notAfter) {
      return ['no time left in this run: the followers wait for the next'];
    }
    const state = await this.db.getState();
    if (!state || state.sync_phase || state.next_height === null) {
      return problems;
    }
    const port = this.profileSitePort();
    for (const follower of this.profileSiteFollowers) {
      try {
        await follower(port, {});
      } catch (error) {
        const message = messageOf(error);
        logger.error(`[PROFILE SITE FOLLOWER FAILED] ${message}`);
        problems.push(message);
      }
    }
    return problems;
  }

  private async allIdentities(): Promise<ChainIdentity[]> {
    const all: ChainIdentity[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.gateway.listIdentities({ after, limit: 500 });
      all.push(...(page?.items ?? []));
      if (!page?.next) return all;
      after = page.next;
    }
  }

  private async fullSyncPairs(state: MirrorState) {
    const pairs: { wallet1: string; wallet2: string }[] = [];
    for (const identity of await this.allIdentities()) {
      const wallets = identity.wallets
        .map((it) => it.toLowerCase())
        .sort((a, b) => (a < b ? -1 : Number(a > b)));
      if (consolidationKeyOf(wallets).length > this.keyWidth) {
        continue;
      }
      for (let i = 0; i < wallets.length; i++) {
        for (let j = i + 1; j < wallets.length; j++) {
          pairs.push({ wallet1: wallets[i], wallet2: wallets[j] });
        }
      }
    }
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceAllPairs(
        pairs,
        CHAIN_BLOCK_BASE + Number(state.sync_from_height),
        this.now(),
        conn
      )
    );
  }

  private async fullSyncDelegations(report: MirrorRunReport) {
    const wanted = new Map<string, DelegationRowWrite[]>();
    const add = (wallet: string, record: ChainDelegation) => {
      const row = toDelegationRow(wallet, record);
      if (!row) return;
      const list = wanted.get(row.from_address) ?? [];
      list.push(row);
      wanted.set(row.from_address, list);
    };
    for (let useCase = 1; useCase <= LAST_USE_CASE; useCase++) {
      let after: string | null = null;
      for (;;) {
        const page = await this.gateway.getDelegations(
          { byUseCase: useCase },
          { after, limit: 1000 }
        );
        for (const record of page?.items ?? []) {
          for (const wallet of await this.walletsOfHolder(record)) {
            add(wallet, record);
          }
        }
        if (!page?.next) break;
        after = page.next;
      }
    }
    const wallets = new Set<string>([
      ...Array.from(wanted.keys()),
      ...(await this.db.walletsWithDelegations())
    ]);
    for (const wallet of Array.from(wallets)) {
      await this.db.executeNativeQueriesInTransaction((conn) =>
        this.db.replaceWalletDelegations(wallet, wanted.get(wallet) ?? [], conn)
      );
      report.delegationWallets++;
    }
  }

  private async walletsOfHolder(record: ChainDelegation): Promise<string[]> {
    if (record.scope === 'wallet') {
      return [record.holder.toLowerCase()];
    }
    const identity = await this.identity(record.holder);
    return identity?.wallets.map((it) => it.toLowerCase()) ?? [];
  }

  // ---------------------------------------------------------------- the feed

  private async followFeed(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    while (this.now() < deadline) {
      const page = await this.feedPage(Number(state.next_height));
      if (!page) {
        logger.warn(
          `[FEED GONE AT ${state.next_height}] [STARTING A FULL SYNC]`
        );
        return await this.startFullSync(state);
      }
      if (page.through < page.from) {
        return state;
      }
      const records = page.blocks.flatMap((block) => block.records);
      await this.applyEffects(feedEffects(records), report, {
        height: page.through,
        source: 'FEED'
      });
      report.feedBlocks += page.through - page.from + 1;
      state = await this.save({ ...state, next_height: page.next });
    }
    return state;
  }

  /**
   * A page of the feed, or null when the gateway no longer holds the height.
   * Asked three times first: another API node behind the gateway may hold it.
   */
  private async feedPage(from: number, bindingsOnly = false) {
    for (let attempt = 0; attempt < FEED_GONE_ATTEMPTS; attempt++) {
      try {
        return await this.gateway.getChanges(from, {
          limit: FEED_PAGE_BLOCKS,
          ...(bindingsOnly ? { families: [ADDRESS_BINDING_FAMILY] } : {})
        });
      } catch (error) {
        if (!(error instanceof ChainGatewayError) || error.code !== 'gone') {
          throw error;
        }
      }
    }
    return null;
  }

  /** Runs one identity's work; a failure is logged and reported, not thrown. */
  private async isolated(
    principalId: string,
    report: MirrorRunReport,
    work: () => Promise<void>
  ) {
    try {
      await work();
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[IDENTITY ${principalId} NOT MIRRORED] ${message}`);
      report.failed.push(`${principalId}: ${message}`);
    }
  }

  /** The principals a feed page touches, with the wallets' old and new ones. */
  private async principalsOf(effects: FeedEffects): Promise<Set<string>> {
    const principals = new Set(effects.principals);
    if (!effects.wallets.size) {
      return principals;
    }
    const wallets = Array.from(effects.wallets);
    const now = await this.gateway.getIdentitiesByWallets(wallets);
    Object.values(now).forEach((it) => {
      if (it) principals.add(it.principalId.toLowerCase());
    });
    (await this.db.principalsOfWallets(wallets)).forEach((it) =>
      principals.add(it)
    );
    return principals;
  }

  private async applyEffects(
    effects: FeedEffects,
    report: MirrorRunReport,
    at: MirrorAt
  ) {
    const principals = await this.principalsOf(effects);
    const touched = new Set<string>(effects.wallets);
    for (const principal of Array.from(principals)) {
      const identity = await this.identity(principal);
      if (!identity) continue;
      await this.isolated(principal, report, async () => {
        (await this.applyIdentity(identity, report, at)).forEach((it) =>
          touched.add(it)
        );
      });
    }
    for (const target of Array.from(effects.ratingTargets)) {
      const identity = await this.identity(target);
      if (!identity) continue;
      await this.isolated(target, report, () =>
        this.syncTargetRatings(identity, report, at)
      );
    }
    for (const holder of Array.from(effects.delegationHolders)) {
      if (HEX20.test(holder)) {
        touched.add(holder);
        continue;
      }
      const identity = await this.identity(holder);
      identity?.wallets.forEach((it) => touched.add(it.toLowerCase()));
    }
    for (const wallet of Array.from(touched)) {
      await this.isolated(wallet, report, () =>
        this.syncWalletDelegations(wallet, report)
      );
    }
  }

  // ---------------------------------------------------------------- one identity

  private async identity(principalId: string): Promise<ChainIdentity | null> {
    const key = principalId.toLowerCase();
    if (!this.identities.has(key)) {
      this.identities.set(key, await this.gateway.getIdentityByPrincipal(key));
    }
    return this.identities.get(key) ?? null;
  }

  private async docOf(
    identity: ChainIdentity,
    report: MirrorRunReport
  ): Promise<ProfileDocFields | null | undefined> {
    const cid = identity.profile?.docCid;
    if (!cid) return null;
    try {
      const bytes = await this.gateway.getProfileDoc(cid);
      if (!bytes) {
        report.docProblems.push(
          `${identity.principalId}: ${cid} not in the store`
        );
        return undefined;
      }
      return toProfileDocFields(decodeProfileDoc(bytes));
    } catch (error) {
      report.docProblems.push(
        `${identity.principalId}: ${(error as Error)?.message ?? error}`
      );
      return undefined;
    }
  }

  /**
   * The 6529.io profile id of a chain identity: its mapping, else
   * - an imported identity's legacy id (its 6529.io profile id);
   * - for an identity made on the chain, the placeholder profile of its
   *   founding wallet (the anchor) when no principal holds it, so that
   *   wallet's follows and history stay with it;
   * - else the principal id's first 16 bytes written as a UUID.
   * 6529.io makes no placeholder profiles from switch-on, so a rebuild from
   * the chain gives the same ids.
   */
  async profileIdOf(identity: ChainIdentity): Promise<string> {
    const principalId = identity.principalId.toLowerCase();
    const mapped = await this.db.profileIdOfPrincipal(principalId);
    if (mapped) return mapped;
    const { profileId: chosen, origin } = await this.chooseProfileId(identity);
    try {
      await this.db.executeNativeQueriesInTransaction((conn) =>
        this.db.insertMapping(principalId, chosen, origin, this.now(), conn)
      );
    } catch (error) {
      // Another run mapped it meanwhile: use that.
      const again = await this.db.profileIdOfPrincipal(principalId);
      if (again) return again;
      throw error;
    }
    return chosen;
  }

  private async chooseProfileId(
    identity: ChainIdentity
  ): Promise<{ profileId: string; origin: string }> {
    const principalId = identity.principalId.toLowerCase();
    const legacy = await this.legacyIdOf(identity);
    if (legacy) return { profileId: legacy, origin: 'LEGACY' };
    const founder = identity.anchor
      ? await this.db.unmappedPlaceholderProfile(identity.anchor)
      : null;
    if (
      founder &&
      !(await this.gateway.getIdentityByLegacyProfileId(founder))
    ) {
      return { profileId: founder.toLowerCase(), origin: 'FOUNDER' };
    }
    return { profileId: principalProfileId(principalId), origin: 'NEW' };
  }

  /**
   * The imported profile id. A gateway that leaves the field out (older
   * than the field) is asked for the import's entry instead, so an imported
   * identity is never taken for one made on the chain.
   */
  private async legacyIdOf(identity: ChainIdentity): Promise<string | null> {
    if (identity.legacyId !== undefined) {
      return identity.legacyId?.toLowerCase() ?? null;
    }
    const entry = await this.gateway.getImportedIdentity(identity.principalId);
    return entry?.legacyId?.toLowerCase() ?? null;
  }

  /**
   * Writes one identity's rows; returns the wallets whose identity changed.
   * A change in which wallets share a key goes to the membership handlers
   * in the same transaction.
   */
  async applyIdentity(
    identity: ChainIdentity,
    report: MirrorRunReport,
    at: MirrorAt
  ): Promise<string[]> {
    const wallets = identity.wallets.map((it) => it.toLowerCase());
    if (isInactive(identity)) {
      report.skippedInactive.push(identity.principalId);
      const survivor = identity.mergedInto
        ? await this.identity(identity.mergedInto)
        : null;
      return survivor?.wallets.length && !survivor.mergedInto
        ? await this.applyIdentity(survivor, report, at)
        : [];
    }
    if (consolidationKeyOf(wallets).length > this.keyWidth) {
      logger.error(
        `[IDENTITY ${identity.principalId} HAS ${wallets.length} WALLETS: TOO MANY FOR A 6529.IO CONSOLIDATION KEY, NOT MIRRORED]`
      );
      report.skippedTooManyWallets.push(identity.principalId);
      return [];
    }
    const doc = await this.docOf(identity, report);
    const profileId = await this.profileIdOf(identity);
    const view: ChainIdentityView = {
      principalId: identity.principalId.toLowerCase(),
      profileId,
      handle: identity.handle,
      wallets,
      primary: (
        identity.primary ??
        identity.anchor ??
        wallets[0]
      ).toLowerCase(),
      doc,
      rep: toNumber(identity.rep?.total),
      cic: toNumber(identity.nic?.total),
      levelRaw: identity.level ? toNumber(identity.level.raw) : null
    };
    const plan = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        const state = await this.db.readIdentityState(
          wallets,
          profileId,
          identity.handle,
          view.primary,
          conn
        );
        const plan = planIdentity(view, state);
        await this.db.applyIdentityPlan(
          plan,
          CHAIN_BLOCK_BASE + Number(identity.createdHeight ?? 0),
          this.now(),
          conn
        );
        await this.membershipChanged(
          membershipChangeOf(plan, state, at.height),
          conn
        );
        return plan;
      }
    );
    report.regroupedWallets = Array.from(
      new Set([...report.regroupedWallets, ...plan.regroupedWallets])
    );
    if (plan.orphanedProfiles.length) {
      logger.warn(
        `[PROFILES LEFT WITHOUT WALLETS] [${plan.orphanedProfiles.join(', ')}] [THEIR WALLETS JOINED ${identity.principalId}]`
      );
      report.orphanedProfiles.push(...plan.orphanedProfiles);
    }
    report.identities++;
    return plan.touchedWallets;
  }

  /** Each membership handler, in the mirror's transaction. */
  private async membershipChanged(
    change: MembershipChange | null,
    conn: ConnectionWrapper<any>
  ) {
    if (!change) return;
    for (const handler of this.membershipHandlers) {
      await handler(change, { connection: conn });
    }
  }

  private ratingRow(
    rating: ChainRating,
    raterProfileId: string
  ): RatingRowWrite | null {
    const value = Math.trunc(toNumber(rating.value));
    if (!value || Math.abs(value) > MAX_RATING) return null;
    const matter = rating.matter.toUpperCase();
    // The help bot's credits stay on 6529.io: none come from the chain.
    if (matter === 'REP' && isHelpBotCreditCategory(rating.category?.name)) {
      return null;
    }
    const base = {
      rater_profile_id: raterProfileId,
      rating: value,
      rater_principal: rating.rater.toLowerCase(),
      height: rating.updatedHeight ?? null
    };
    if (matter === 'NIC' || matter === 'CIC') {
      return { ...base, matter: 'CIC', matter_category: 'CIC' };
    }
    if (matter !== 'REP' || !rating.category?.name) return null;
    return { ...base, matter: 'REP', matter_category: rating.category.name };
  }

  /**
   * A target's REP and CIC rows become the chain's ratings of it; each
   * change goes to the rating event log in the same transaction.
   */
  async syncTargetRatings(
    identity: ChainIdentity,
    report: MirrorRunReport,
    at: MirrorAt
  ) {
    if (isInactive(identity)) return;
    const targetProfileId = await this.profileIdOf(identity);
    const ratings: ChainRating[] = [];
    if ((identity.rep?.raters ?? 0) + (identity.nic?.raters ?? 0) > 0) {
      let after: string | null = null;
      for (;;) {
        const page = await this.gateway.getRatings(
          { target: identity.principalId },
          { after, limit: 1000 }
        );
        ratings.push(...(page?.items ?? []));
        if (!page?.next) break;
        after = page.next;
      }
    }
    const rows: RatingRowWrite[] = [];
    for (const rating of ratings) {
      const rater = await this.identity(rating.rater);
      if (!rater) continue;
      const row = this.ratingRow(rating, await this.profileIdOf(rater));
      if (row) rows.push(row);
    }
    const events: RatingEventContext = {
      targetPrincipal: identity.principalId.toLowerCase(),
      height: at.height,
      source: at.source
    };
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceTargetRatings(
        targetProfileId,
        rows,
        this.now(),
        events,
        conn
      )
    );
    report.ratingTargets++;
  }

  /** A wallet's delegation rows become its own and its identity's records. */
  async syncWalletDelegations(wallet: string, report: MirrorRunReport) {
    const groups = (await this.gateway.getDelegationsOfWallet(wallet)) ?? [];
    const rows: DelegationRowWrite[] = [];
    for (const group of groups) {
      let records = group.records;
      if (group.more) {
        records = [];
        let after: string | null = null;
        for (;;) {
          const page = await this.gateway.getDelegations(
            { holder: group.holder },
            { after, limit: 1000 }
          );
          records.push(...(page?.items ?? []));
          if (!page?.next) break;
          after = page.next;
        }
      }
      for (const record of records) {
        const row = toDelegationRow(wallet, record);
        if (row) rows.push(row);
      }
    }
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceWalletDelegations(wallet.toLowerCase(), rows, conn)
    );
    report.delegationWallets++;
  }
}

export const identityChainMirror = new IdentityChainMirror();

export { toDelegationRow };
