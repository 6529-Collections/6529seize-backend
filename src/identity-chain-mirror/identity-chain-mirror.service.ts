import {
  ChainGatewayClient,
  chainGatewayClient,
  ChainGatewayError
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
  MirrorRetry,
  MirrorState,
  NO_RETRY,
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
  planIdentity
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
import { HEX20, HEX32 } from './wallet-bindings';
import { WalletBindingsFollower } from './wallet-bindings-follower';
import {
  allPages,
  isOtherChain,
  readWholeBlocks,
  realSleep,
  Sleep
} from './chain-feed-pages';
import { ChainReadRetryLater, messageOf } from './mirror-errors';
import { covers, isInactive, ProfileIds } from './profile-ids';

export { covers, isInactive };
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
/** Past this many keys to try again, a full sync is quicker. */
const RETRY_LIMIT = 10_000;
/** At most this many keys are tried again in one run. */
const RETRY_BATCH = 500;
/** A new network id is read this many more times before anything is wiped. */
const NETWORK_CONFIRMATIONS = 2;
const NETWORK_CONFIRM_WAIT_MS = 1_000;
const IDENTITY_PAGE = 200;
const LAST_USE_CASE = 998;
/** ratings.rating is a signed 32-bit int. */
const MAX_RATING = 2_147_483_647;

/**
 * Called by `followProfileSites()`, which the delegations loop runs as its
 * last step, with the profile site index's chain reads; each follows the
 * chain from its own cursor. The profile site index adds its
 * `followProfileCmsChanges` here.
 */
export const PROFILE_SITE_FOLLOWERS: readonly ProfileSiteFollower[] = [];

/** Profiles listed per transaction when the placeholders are listed. */
const PLACEHOLDER_CHUNK = 10_000;
/** The wallet bindings take at most this share of a run's budget. */
const BINDINGS_SHARE = 0.5;
/** The profile site followers' pass ends after this long. */
const FOLLOWERS_BUDGET_MS = 4 * 60 * 1000;

type Gateway = Pick<
  ChainGatewayClient,
  | 'getHead'
  | 'getMembership'
  | 'listMembershipWallets'
  | 'getMembershipWalletHistory'
  | 'getImportedIdentity'
  | 'getMembershipWallet'
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
  skipped?: 'import_not_complete' | 'network_unsettled';
  /** Why the run stopped early; what it did before is in the report. */
  error?: string;
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
  /** Keys left to try again next run (principals, targets, wallets). */
  retryLeft: number;
  /** Wallets whose consolidation key changed: re-keyed by the caller. */
  regroupedWallets: string[];
  /** Other profiles whose wallets all joined an identity: left without a row. */
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

/** The gateway no longer (or not yet) holds a pinned height. */
function isHeightGone(error: unknown): boolean {
  return error instanceof ChainGatewayError && error.code === 'height_gone';
}

export type RetryKind = keyof MirrorRetry;
type RetrySets = { [kind in RetryKind]: Set<string> };

function emptyRetrySets(): RetrySets {
  return { principals: new Set(), targets: new Set(), wallets: new Set() };
}

function retrySize(retry: MirrorRetry): number {
  return retry.principals.length + retry.targets.length + retry.wallets.length;
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
  /** Keys a run failed to write, saved with the state. */
  private retry: RetrySets = emptyRetrySets();
  /** The keys earlier runs left, tried again once by this run. */
  private leftByEarlierRuns: MirrorRetry = NO_RETRY;
  /**
   * The finalized height the current page's reads are pinned to, at or past
   * what the page needs (undefined between pages: the client's own).
   */
  private readAt: number | undefined = undefined;
  private readonly ids: ProfileIds;
  private readonly bindings: WalletBindingsFollower;

  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly db: IdentityChainMirrorDb = identityChainMirrorDb,
    private readonly now: () => number = () => Date.now(),
    private readonly membershipHandlers: readonly MembershipChangeHandler[] = MEMBERSHIP_CHANGE_HANDLERS,
    private readonly profileSiteFollowers: readonly ProfileSiteFollower[] = PROFILE_SITE_FOLLOWERS,
    private readonly sleep: Sleep = realSleep
  ) {
    this.bindings = new WalletBindingsFollower(gateway, db, now, sleep);
    this.ids = new ProfileIds(gateway, db, now);
  }

  /** The 6529.io profile id of a chain identity (mapped now if needed). */
  profileIdOf(identity: ChainIdentity): Promise<string> {
    return this.ids.profileIdOf(identity);
  }

  /** The profile id the profile site index files an identity under. */
  profileIdForSites(
    identity: ChainIdentity
  ): Promise<{ profileId: string; imported: boolean }> {
    return this.ids.profileIdForSites(identity);
  }

  /**
   * The profile site index's chain reads, with this mirror's profile ids;
   * past `deadline` a read of changes ends the follower's pass.
   */
  profileSitePort(deadline?: number): GatewayProfileSitePort {
    const lookups = new IdentityChainLookups(this.db, this.gateway);
    return new GatewayProfileSitePort(
      this.gateway,
      (identity) => this.profileIdForSites(identity),
      (wallet, height) => lookups.walletPrincipalAt(wallet, height),
      { deadline, now: this.now }
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
      retryLeft: 0,
      regroupedWallets: [],
      orphanedProfiles: [],
      walletBindings: 0,
      bindingProblems: [],
      bindingsNextHeight: null,
      nextHeight: null
    };
  }

  /**
   * One run. A failure part way is returned in `error` with what the run
   * did before it (wallets it regrouped are re-keyed by the caller either
   * way), not thrown.
   */
  async run({ budgetMs }: { budgetMs: number }): Promise<MirrorRunReport> {
    const report = this.report();
    try {
      await this.runInto(report, budgetMs);
    } catch (error) {
      report.error = messageOf(error);
      logger.error(`[RUN STOPPED] ${report.error}`);
    } finally {
      this.readAt = undefined;
    }
    return report;
  }

  private async runInto(report: MirrorRunReport, budgetMs: number) {
    const deadline = this.now() + budgetMs;
    this.identities.clear();
    this.readAt = undefined;
    const loaded = (await this.db.getState()) ?? this.emptyState();
    this.leftByEarlierRuns = loaded.retry;
    this.retry = {
      principals: new Set(loaded.retry.principals),
      targets: new Set(loaded.retry.targets),
      wallets: new Set(loaded.retry.wallets)
    };
    // Before the import gate: a relaunched chain is seen while its import runs.
    const onChain = await this.onThisChain(loaded);
    if (!onChain) {
      report.skipped = 'network_unsettled';
      return;
    }
    let state = onChain;
    const membership = await this.gateway.getMembership();
    const importState = membership?.import as
      | {
          completed?: boolean;
          startHeight?: number | null;
          doneHeight?: number | null;
        }
      | undefined;
    if (!importState?.completed) {
      report.skipped = 'import_not_complete';
      return;
    }
    this.ids.setImportHeights(
      numberOrNull(importState.startHeight),
      numberOrNull(importState.doneHeight)
    );
    this.keyWidth =
      (await this.db.consolidationKeyWidth()) ?? MAX_CONSOLIDATION_KEY_LENGTH;
    state = await this.listPlaceholders(state);
    state = await this.bindings.follow(
      state,
      numberOrNull(importState.startHeight),
      Math.min(deadline, this.now() + budgetMs * BINDINGS_SHARE),
      report
    );
    report.bindingsNextHeight = state.bindings_next_height;
    state = await this.syncIdentities(state, deadline, report);
    report.nextHeight = state.next_height;
    report.retryLeft = retrySize(state.retry);
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
      chain_id: null,
      placeholders_at: null,
      retry: NO_RETRY
    };
  }

  /** Saves the state with the keys left to try again. */
  private async save(state: MirrorState): Promise<MirrorState> {
    const saved: MirrorState = {
      ...state,
      retry: {
        principals: Array.from(this.retry.principals),
        targets: Array.from(this.retry.targets),
        wallets: Array.from(this.retry.wallets)
      }
    };
    await this.db.saveState(saved, this.now());
    return saved;
  }

  // ---------------------------------------------------------------- full sync

  private async startFullSync(state: MirrorState): Promise<MirrorState> {
    const head = await this.gateway.getHead(true);
    logger.info(`[FULL SYNC FROM HEIGHT ${head.finalizedHeight}]`);
    // The full sync writes everything again: nothing is left to retry.
    this.retry = emptyRetrySets();
    this.leftByEarlierRuns = NO_RETRY;
    return await this.save({
      ...state,
      sync_from_height: head.finalizedHeight,
      sync_phase: 'IDENTITIES',
      sync_after: null
    });
  }

  // ---------------------------------------------------------------- chain and placeholders

  /**
   * The chain the mirror reads is named by its network id. On another one
   * (a relaunch, which only test chains have): an empty bindings table, the
   * mappings of identities made on the old chain removed, and a full sync
   * once the new chain's import completes; rows of identities only the old
   * chain had are not deleted. A gateway that gives no network id changes
   * nothing. A new id is read again before anything is wiped, so one answer
   * from a node of another chain doesn't wipe: null (no run) while the
   * answers differ.
   */
  private async onThisChain(state: MirrorState): Promise<MirrorState | null> {
    const network = await this.networkNow();
    if (network === null || state.chain_id === network) return state;
    if (state.chain_id === null) {
      return await this.save({ ...state, chain_id: network });
    }
    for (let i = 0; i < NETWORK_CONFIRMATIONS; i++) {
      await this.sleep(NETWORK_CONFIRM_WAIT_MS);
      const again = await this.networkNow();
      if (again !== network) {
        logger.warn(
          `[NETWORK UNSETTLED] [${state.chain_id}] [${network}] [${again}] [NEXT RUN]`
        );
        return null;
      }
    }
    logger.warn(
      `[ANOTHER CHAIN] [${state.chain_id}] [NOW ${network}] [STARTING AGAIN]`
    );
    // The placeholder list is of 6529.io's profiles: it stays.
    const fresh: MirrorState = {
      ...this.emptyState(),
      chain_id: network,
      placeholders_at: state.placeholders_at
    };
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      await this.db.clearWalletBindings(conn);
      await this.db.clearChainMadeMappings(conn);
      await this.db.saveState(fresh, this.now(), conn);
    });
    this.retry = emptyRetrySets();
    this.leftByEarlierRuns = NO_RETRY;
    return fresh;
  }

  private async networkNow(): Promise<string | null> {
    return (await this.gateway.getHead(true)).network?.toLowerCase() ?? null;
  }

  /**
   * The placeholder profiles, listed once before the mirror's first write,
   * in chunks. A run cut short lists again from the start (listing is
   * idempotent); the time is saved after the last chunk.
   */
  private async listPlaceholders(state: MirrorState): Promise<MirrorState> {
    if (state.placeholders_at !== null) return state;
    let after: string | null = '';
    while (after !== null) {
      after = await this.db.listPlaceholderProfiles(after, PLACEHOLDER_CHUNK);
    }
    return await this.save({ ...state, placeholders_at: this.now() });
  }

  private async continueFullSync(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    const from = Number(state.sync_from_height);
    // Each page reads at one height at or past the sync's own; a height the
    // node no longer holds ends the run, to go on from the page next time.
    const pinned = async (work: () => Promise<void>): Promise<boolean> =>
      (await this.pinReads(from)) && (await this.unlessHeightGone(work));
    while (state.sync_phase === 'IDENTITIES' && this.now() < deadline) {
      const at: MirrorAt = { height: from, source: 'FULL_SYNC' };
      const read: { next: string | null } = { next: null };
      const done = await pinned(async () => {
        const page = await this.gateway.listIdentities({
          after: state.sync_after,
          limit: IDENTITY_PAGE,
          ...this.pin()
        });
        for (const identity of page?.items ?? []) {
          await this.isolated(
            ['principals', 'targets'],
            identity.principalId,
            report,
            async () => {
              await this.applyIdentity(identity, report, at);
              return await this.syncTargetRatings(identity, report, at);
            }
          );
        }
        read.next = page?.next ?? null;
      });
      if (!done) return state;
      state = await this.save(
        read.next
          ? { ...state, sync_after: read.next }
          : { ...state, sync_phase: 'DELEGATIONS', sync_after: null }
      );
    }
    if (state.sync_phase === 'DELEGATIONS' && this.now() < deadline) {
      if (!(await this.fullSyncDelegations(report, from))) return state;
      state = await this.save({ ...state, sync_phase: 'CONSOLIDATIONS' });
    }
    if (state.sync_phase === 'CONSOLIDATIONS' && this.now() < deadline) {
      if (!(await pinned(() => this.fullSyncPairs(state)))) return state;
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
  async followProfileSites(
    notAfter?: number,
    budgetMs = FOLLOWERS_BUDGET_MS
  ): Promise<string[]> {
    const problems: string[] = [];
    if (!this.profileSiteFollowers.length) return problems;
    if (notAfter !== undefined && this.now() > notAfter) {
      logger.info(
        '[PROFILE SITE FOLLOWERS WAIT FOR THE NEXT RUN] [NO TIME LEFT]'
      );
      return problems;
    }
    const state = await this.db.getState();
    if (!state || state.sync_phase || state.next_height === null) {
      return problems;
    }
    const port = this.profileSitePort(this.now() + budgetMs);
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
    return await allPages((after) =>
      this.gateway.listIdentities({ after, limit: 500, ...this.pin() })
    );
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

  /**
   * Every delegation, each use case read at one height at or past `from`;
   * false when the node can't serve such a height now (nothing written).
   */
  private async fullSyncDelegations(
    report: MirrorRunReport,
    from: number
  ): Promise<boolean> {
    const wanted = new Map<string, DelegationRowWrite[]>();
    const add = (wallet: string, record: ChainDelegation) => {
      const row = toDelegationRow(wallet, record);
      if (!row) return;
      const list = wanted.get(row.from_address) ?? [];
      list.push(row);
      wanted.set(row.from_address, list);
    };
    for (let useCase = 1; useCase <= LAST_USE_CASE; useCase++) {
      if (!(await this.pinReads(from))) return false;
      const read = await this.unlessHeightGone(async () => {
        const records = await allPages((after) =>
          this.gateway.getDelegations(
            { byUseCase: useCase },
            { after, limit: 1000, ...this.pin() }
          )
        );
        for (const record of records) {
          for (const wallet of await this.walletsOfHolder(record)) {
            add(wallet, record);
          }
        }
      });
      if (!read) return false;
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
    return true;
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
    if (retrySize(state.retry) > RETRY_LIMIT) {
      logger.warn(`[OVER ${RETRY_LIMIT} TO RETRY] [STARTING A FULL SYNC]`);
      return await this.startFullSync(state);
    }
    state = await this.retryFailed(state, report);
    while (this.now() < deadline) {
      const from = Number(state.next_height);
      const read = await readWholeBlocks(this.gateway, from, {
        limit: FEED_PAGE_BLOCKS,
        sleep: this.sleep
      });
      if (!read) {
        logger.warn(`[FEED GONE AT ${from}] [STARTING A FULL SYNC]`);
        return await this.startFullSync(state);
      }
      if (read.atHead || read.nextHeight <= from) {
        return state;
      }
      if (!(await this.readsReach(state, read))) return state;
      // The identities a page touches are read again for each page, all at
      // one height that includes it.
      const records = read.blocks.flatMap((block) => block.records);
      const applied = await this.unlessHeightGone(() =>
        this.applyEffects(feedEffects(records), report, {
          height: read.nextHeight - 1,
          source: 'FEED'
        })
      );
      if (!applied) return state;
      report.feedBlocks += read.blocks.length;
      state = await this.save({ ...state, next_height: read.nextHeight });
      if (retrySize(state.retry) > RETRY_LIMIT) {
        logger.warn(`[OVER ${RETRY_LIMIT} TO RETRY] [STARTING A FULL SYNC]`);
        return await this.startFullSync(state);
      }
    }
    return state;
  }

  /**
   * Tries again, once a run and at most RETRY_BATCH keys, what earlier runs
   * could not write and is still left, read at one finalized height past
   * the last page read. What fails again, or isn't reached, stays.
   */
  private async retryFailed(
    state: MirrorState,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let room = RETRY_BATCH;
    const left = (kind: RetryKind) => {
      const keys = this.leftByEarlierRuns[kind]
        .filter((it) => this.retry[kind].has(it))
        .slice(0, room);
      room -= keys.length;
      return new Set(keys);
    };
    const principals = left('principals');
    const targets = left('targets');
    const wallets = left('wallets');
    this.leftByEarlierRuns = NO_RETRY;
    if (!principals.size && !targets.size && !wallets.size) return state;
    const last = Number(state.next_height) - 1;
    if (!(await this.pinReads(last))) return state;
    const applied = await this.unlessHeightGone(() =>
      this.applyEffects(
        {
          principals,
          wallets: new Set<string>(),
          ratingTargets: targets,
          delegationHolders: wallets
        },
        report,
        { height: last, source: 'FEED' }
      )
    );
    return applied ? await this.save(state) : state;
  }

  /**
   * Whether the identity reads that follow a feed page see it: the page is
   * of the mirror's chain, and they are pinned to a finalized height at or
   * past the page's last height.
   */
  private async readsReach(
    state: MirrorState,
    read: { nextHeight: number; network: string | null }
  ): Promise<boolean> {
    if (isOtherChain(state.chain_id, read.network)) {
      logger.warn(`[FEED PAGE OF ANOTHER CHAIN] [${read.network}] [NEXT RUN]`);
      return false;
    }
    return await this.pinReads(read.nextHeight - 1);
  }

  /**
   * Pins the reads that follow to the gateway's finalized height, read
   * again when it is below `least`; false while it is (a node behind,
   * waited for until the next run). The gateway serves a pinned height for
   * about 13 minutes, a page's reads take seconds, and a height already
   * past is never read again, so the head going back (another node) can't
   * make a page read older state.
   */
  private async pinReads(least: number): Promise<boolean> {
    let head = await this.gateway.getHead();
    if (head.finalizedHeight < least) head = await this.gateway.getHead(true);
    if (head.finalizedHeight < least) {
      logger.warn(`[READS BEHIND AT ${least}] [NEXT RUN]`);
      return false;
    }
    this.readAt = head.finalizedHeight;
    this.identities.clear();
    return true;
  }

  /** The pinned height for a read, when one is set. */
  private pin(): { height?: number } {
    return this.readAt === undefined ? {} : { height: this.readAt };
  }

  /**
   * Runs work whose reads are pinned; false when the gateway no longer (or
   * not yet) holds the pinned height: the run stops there, to go on from the
   * same place next time.
   */
  private async unlessHeightGone(work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (!isHeightGone(error)) throw error;
      logger.warn(`[PINNED HEIGHT ${this.readAt} GONE] [NEXT RUN]`);
      return false;
    }
  }

  /**
   * Runs one key's work. A failure is logged and reported, not thrown, and
   * the key is kept to try again; a success takes it off, but for the kinds
   * the work says are left (written in part). A pinned height the gateway
   * no longer holds is thrown: the whole page is read again.
   */
  private async isolated(
    kinds: RetryKind[],
    key: string,
    report: MirrorRunReport,
    work: () => Promise<RetryKind[] | void>
  ) {
    const id = key.toLowerCase();
    try {
      const left = (await work()) ?? [];
      kinds.forEach((kind) =>
        left.includes(kind)
          ? this.retry[kind].add(id)
          : this.retry[kind].delete(id)
      );
    } catch (error) {
      if (isHeightGone(error)) throw error;
      const message = messageOf(error);
      logger.error(`[${id} NOT MIRRORED] ${message}`);
      report.failed.push(`${id}: ${message}`);
      kinds.forEach((kind) => this.retry[kind].add(id));
    }
  }

  /** The principals a feed page touches, with the wallets' old and new ones. */
  private async principalsOf(effects: FeedEffects): Promise<Set<string>> {
    const principals = new Set(effects.principals);
    if (!effects.wallets.size) {
      return principals;
    }
    const wallets = Array.from(effects.wallets);
    const now = await this.gateway.getIdentitiesByWallets(wallets, this.pin());
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
      if (!identity) {
        this.retry.principals.delete(principal.toLowerCase());
        continue;
      }
      await this.isolated(['principals'], principal, report, async () => {
        (await this.applyIdentity(identity, report, at)).forEach((it) =>
          touched.add(it)
        );
      });
    }
    for (const target of Array.from(effects.ratingTargets)) {
      const identity = await this.identity(target);
      if (!identity) {
        this.retry.targets.delete(target.toLowerCase());
        continue;
      }
      await this.isolated(['targets'], target, report, () =>
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
      await this.isolated(['wallets'], wallet, report, () =>
        this.syncWalletDelegations(wallet, report)
      );
    }
  }

  // ---------------------------------------------------------------- one identity

  private async identity(principalId: string): Promise<ChainIdentity | null> {
    const key = principalId.toLowerCase();
    if (!this.identities.has(key)) {
      this.identities.set(
        key,
        await this.gateway.getIdentityByPrincipal(key, this.pin())
      );
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
      report.docProblems.push(`${identity.principalId}: ${messageOf(error)}`);
      return undefined;
    }
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
   * change goes to the rating event log in the same transaction. A rater
   * whose profile id can't be settled yet is left as it is (it has no rows
   * until it is mapped, or keeps the ones it has), the others are written,
   * and the target is left to try again (['targets']).
   */
  async syncTargetRatings(
    identity: ChainIdentity,
    report: MirrorRunReport,
    at: MirrorAt
  ): Promise<RetryKind[]> {
    if (isInactive(identity)) return [];
    const targetProfileId = await this.profileIdOf(identity);
    const ratings: ChainRating[] = [];
    if ((identity.rep?.raters ?? 0) + (identity.nic?.raters ?? 0) > 0) {
      let after: string | null = null;
      for (;;) {
        const page = await this.gateway.getRatings(
          { target: identity.principalId },
          { after, limit: 1000, ...this.pin() }
        );
        ratings.push(...(page?.items ?? []));
        if (!page?.next) break;
        after = page.next;
      }
    }
    const rows: RatingRowWrite[] = [];
    const unsettled: string[] = [];
    for (const rating of ratings) {
      const rater = await this.identity(rating.rater);
      if (!rater) continue;
      let raterProfileId: string;
      try {
        // A merged or closed rater is named without storing a mapping for it.
        raterProfileId = isInactive(rater)
          ? (await this.profileIdForSites(rater)).profileId
          : await this.profileIdOf(rater);
      } catch (error) {
        if (!(error instanceof ChainReadRetryLater)) throw error;
        unsettled.push(rater.principalId);
        continue;
      }
      const row = this.ratingRow(rating, raterProfileId);
      if (row) rows.push(row);
    }
    if (unsettled.length) {
      logger.warn(
        `[RATERS NOT SETTLED] [${identity.principalId}] [${unsettled.join(', ')}] [TRIED AGAIN]`
      );
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
        conn,
        { keepUnlisted: unsettled.length > 0 }
      )
    );
    report.ratingTargets++;
    return unsettled.length ? ['targets'] : [];
  }

  /** A wallet's delegation rows become its own and its identity's records. */
  async syncWalletDelegations(wallet: string, report: MirrorRunReport) {
    const groups =
      (await this.gateway.getDelegationsOfWallet(wallet, this.pin())) ?? [];
    const rows: DelegationRowWrite[] = [];
    for (const group of groups) {
      let records = group.records;
      if (group.more) {
        records = [];
        let after: string | null = null;
        for (;;) {
          const page = await this.gateway.getDelegations(
            { holder: group.holder },
            { after, limit: 1000, ...this.pin() }
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
