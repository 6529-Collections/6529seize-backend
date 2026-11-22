import {
  ChainGatewayClient,
  chainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainDelegation,
  ChainFeedBlock,
  ChainFeedRecord,
  ChainIdentity,
  ChainRating
} from '@/chain-gateway/chain-gateway.types';
import { USE_CASE_PRIMARY_ADDRESS } from '@/constants';
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
  RatingEventRow,
  RatingRowWrite,
  ratingTotalKey,
  ratingValueKey
} from './identity-chain-mirror.db';
import {
  categoryKey,
  ratingChangesOf,
  ratingEventOrigin,
  writerText
} from './rating-events';
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
/** During a full sync, the feed's share of each run (it goes first). */
const FEED_SHARE_IN_FULL_SYNC = 0.4;
/** A level sweep's share of a run (it goes before the identities). */
const LEVEL_SWEEP_SHARE = 0.25;
/** Identities per page of the chain's level ranking. */
const LEVEL_PAGE = 500;
/**
 * A feed page's keys (identities, rating targets, wallets) written in one
 * go at most; the rest go to the retry list.
 */
const PAGE_KEYS = 2_000;
/**
 * A pinned height is served about 13 minutes: a page's writes stop well
 * before (the rest are tried again).
 */
const PIN_WINDOW_MS = 8 * 60 * 1000;
/** Rating events whose profile ids are filled in once mapped: the last day. */
const RATING_EVENT_FILL_MS = 24 * 60 * 60 * 1000;
/** Identities waiting to be retried whose ids a fix of rows can leave out. */
const MAX_WAITING_LEFT_OUT = 500;
/** As many for the levels off the chain each run (it reads each one). */
const MAX_WAITING_EACH_RUN = 50;
/** Chunks of 1,000 rows the levels off the chain take each run. */
const OFF_CHAIN_CHUNKS_A_RUN = 20;
/** Environment flag: a new network id starts the mirror again (test stages). */
export const RELAUNCH_ALLOWED_ENV = 'IDENTITY_CHAIN_MIRROR_RELAUNCH_ALLOWED';
/** A new network id is read this many more times before anything is wiped. */
const NETWORK_CONFIRMATIONS = 2;
const NETWORK_CONFIRM_WAIT_MS = 1_000;
const IDENTITY_PAGE = 200;
/**
 * The delegation use cases the 6529 chain's Delegation records take: 1 to
 * 17, 997 (primary address) and 998 (sub-delegation); a consolidation (999)
 * is an identity there. The gateway lists no use cases, so the full sync
 * walks these.
 */
export const CHAIN_DELEGATION_USE_CASES: readonly number[] = [
  ...Array.from({ length: 17 }, (_, i) => i + 1),
  997,
  998
];
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
  | 'getLevelRanking'
  | 'getTdh'
  | 'getState'
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
  /** Levels of mapped identities a level sweep gave to write. */
  levelsSwept: number;
  /** The TDH day a level sweep under way is for, when one is. */
  levelSweepDay: number | null;
  /** Why a level sweep stopped early (it goes on next run). */
  levelSweepProblem?: string;
  /** Why the gateway's node says it isn't ready (its state is still read). */
  gatewayNotReady?: string;
  /** Keys a feed page left for later runs (the page's place moved on). */
  deferred: number;
  /** Rating event rows the feed's Rating records gave (new ones written). */
  ratingEvents: number;
  /** Rating event rows of the last day given a profile id now mapped. */
  ratingEventsFilled: number;
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

/** An answer from another chain's node than the head names. */
function isWrongNetwork(error: unknown): boolean {
  return error instanceof ChainGatewayError && error.code === 'wrong_network';
}

/**
 * A read the page can't use: the gateway no longer (or not yet) holds the
 * pinned height, or answered from another chain's node.
 */
function isHeightGone(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    (error.code === 'height_gone' || error.code === 'wrong_network')
  );
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
  readonly source: 'FEED' | 'FULL_SYNC';
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
/** The principals a record's fields name as its target. */
function targetsOf(record: ChainFeedRecord): Set<string> {
  const targets = new Set<string>();
  for (const fields of [record.keyFields, record.valueFields]) {
    for (const [name, raw] of Object.entries(fields ?? {})) {
      const value = typeof raw === 'string' ? raw.toLowerCase() : '';
      if (/target/i.test(name) && HEX32.test(value)) targets.add(value);
    }
  }
  return targets;
}

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
      // A rating moves its target's ratings, totals and level; the rater's
      // rows don't change. Without a field naming the target, every id.
      const targets = targetsOf(record);
      (targets.size ? targets : ids).forEach((it) => {
        effects.ratingTargets.add(it);
        effects.principals.add(it);
      });
    } else if (/delegation/i.test(name)) {
      ids.forEach((it) => effects.delegationHolders.add(it));
      wallets.forEach((it) => effects.delegationHolders.add(it));
      // An identity's `primary` comes from its use case 997 records at the
      // read: the identity is read again (a record that only expires is
      // caught by the next full sync).
      const useCase = Number(
        record.keyFields?.useCase ?? record.valueFields?.useCase
      );
      if (!Number.isFinite(useCase) || useCase === USE_CASE_PRIMARY_ADDRESS) {
        ids.forEach((it) => effects.principals.add(it));
      }
    } else if (/^rater/i.test(name)) {
      // A rater's own records (its budget, when it last rated) change no row
      // of 6529.io's: its ratings come with the Rating records.
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
  /** The highest height pinned in this run: no later pin goes below it. */
  private highestPin = 0;
  /** The latest TDH day on the levels of the identities read this run. */
  private seenTdhDay: number | null = null;
  /** The lowest chain height that day was seen at in this run. */
  private seenTdhDayHeight: number | null = null;
  /** When the current pin was taken. */
  private pinnedAt = 0;
  /** REP category names by id (a category's name never changes). */
  private readonly categoryNames = new Map<string, string>();
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
      levelsSwept: 0,
      levelSweepDay: null,
      deferred: 0,
      ratingEvents: 0,
      ratingEventsFilled: 0,
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
      report.orphanedProfiles.push(...this.ids.takeLeftPlaceholders());
    }
    return report;
  }

  /**
   * Wallets the mirror regrouped and whose tables wait to be re-keyed
   * (kept across runs: a run cut short loses none), oldest first.
   */
  async pendingRegroups(limit: number): Promise<string[]> {
    return await this.db.pendingRegroups(limit);
  }

  /** Re-keyed: off the queue, unless queued again since `before`. */
  async regroupsDone(wallets: string[], before: number) {
    await this.db.regroupsDone(wallets, before);
  }

  /** Wallets a re-keying batch took up and didn't finish. */
  async unfinishedRegroups(): Promise<number> {
    return await this.db.unfinishedRegroups();
  }

  /** A re-keying batch takes these wallets up. */
  async regroupsStarted(wallets: string[]) {
    await this.db.regroupsStarted(wallets, this.now());
  }

  private async runInto(report: MirrorRunReport, budgetMs: number) {
    const deadline = this.now() + budgetMs;
    this.identities.clear();
    this.readAt = undefined;
    this.highestPin = 0;
    this.seenTdhDay = null;
    this.seenTdhDayHeight = null;
    const loaded = (await this.db.getState()) ?? this.emptyState();
    this.leftByEarlierRuns = loaded.retry;
    this.retry = {
      principals: new Set(loaded.retry.principals),
      targets: new Set(loaded.retry.targets),
      wallets: new Set(loaded.retry.wallets)
    };
    // Before the import gate: a relaunched chain is seen while its import runs.
    const onChain = await this.onThisChain(loaded, report);
    if (!onChain) {
      report.skipped = 'network_unsettled';
      return;
    }
    let state = onChain;
    // No run pins below what an earlier one read (on this chain).
    this.highestPin = state.pin_floor ?? 0;
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
    // The chain's TDH day, so a quiet feed still starts a level sweep; a
    // sweep after a TDH day goes first with its share, so the feed's newer
    // reads come after it.
    await this.readTdhDay();
    state = await this.noteTdhDay(state);
    state = await this.sweepLevels(
      state,
      this.now() + (deadline - this.now()) * LEVEL_SWEEP_SHARE,
      report
    );
    state = await this.syncIdentities(state, deadline, report);
    // Profile ids of rating events whose rater or target is mapped since.
    report.ratingEventsFilled = await this.db.fillRatingEventProfiles(
      this.now() - RATING_EVENT_FILL_MS
    );
    // Once a first full sync has ended: before, every row waits for it.
    if (state.last_full_sync_at !== null) {
      state = await this.stepLevelsOffTheChain(state);
    }
    state = await this.noteTdhDay(state);
    report.levelSweepDay = state.level_sweep_day;
    report.nextHeight = state.next_height;
    report.retryLeft = retrySize(state.retry);
  }

  /**
   * The identity tables: the change feed, and a full sync when one is due
   * or under way. A full sync takes hours; the feed goes first in every run
   * with its share of the time, so the site's changes never wait for it.
   */
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
    if (!state.sync_phase) {
      report.mode = 'feed';
      return await this.followFeed(state, deadline, report);
    }
    report.mode = 'full_sync';
    const feedUntil =
      this.now() + (deadline - this.now()) * FEED_SHARE_IN_FULL_SYNC;
    state = await this.followFeed(state, feedUntil, report);
    return state.sync_phase
      ? await this.continueFullSync(state, deadline, report)
      : state;
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
      bindings_exact: false,
      levels_tdh_day: null,
      level_sweep_day: null,
      level_sweep_after: null,
      levels_day_height: null,
      sync_use_case: null,
      sync_wallet_after: null,
      pin_floor: null,
      off_chain_after: null,
      retry: NO_RETRY
    };
  }

  /** Saves the state with the keys left to try again. */
  private async save(state: MirrorState): Promise<MirrorState> {
    const floor = Math.max(state.pin_floor ?? 0, this.highestPin);
    const saved: MirrorState = {
      ...state,
      pin_floor: floor > 0 ? floor : null,
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

  /**
   * Starts a full sync at the gateway's finalized height. The feed goes on
   * from where it is, or, the first time or when the feed no longer holds
   * its place (`feedGone`), from the height after the sync's.
   */
  private async startFullSync(
    state: MirrorState,
    feedGone = false
  ): Promise<MirrorState> {
    const head = await this.gateway.getHead(true);
    logger.info(`[FULL SYNC FROM HEIGHT ${head.finalizedHeight}]`);
    // The full sync writes everything again: nothing is left to retry.
    this.retry = emptyRetrySets();
    this.leftByEarlierRuns = NO_RETRY;
    return await this.save({
      ...state,
      next_height:
        state.next_height === null || feedGone
          ? head.finalizedHeight + 1
          : state.next_height,
      sync_from_height: head.finalizedHeight,
      sync_phase: 'IDENTITIES',
      sync_after: null,
      sync_use_case: null,
      sync_wallet_after: null
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
  private async onThisChain(
    state: MirrorState,
    report: MirrorRunReport
  ): Promise<MirrorState | null> {
    const head = await this.gateway.getHead(true);
    if (head.ready === false) {
      // Its finalized state is still read: the feed and reads wait for it
      // by height where they need to.
      report.gatewayNotReady = head.notReady ?? 'not ready';
      logger.warn(
        `[GATEWAY NODE NOT READY] [${report.gatewayNotReady}] [READING ITS FINALIZED STATE]`
      );
    }
    const network = head.network?.toLowerCase() ?? null;
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
    if (process.env[RELAUNCH_ALLOWED_ENV] !== 'true') {
      // In production another chain is a misconfiguration: nothing wiped.
      throw new Error(
        `The gateway serves another chain (${network}) than the mirror's (${state.chain_id}); only a stage with ${RELAUNCH_ALLOWED_ENV}=true starts again`
      );
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
      await this.db.clearLevelHeights(conn);
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
      const read: {
        next: string | null;
        last: string | null;
        stopped: boolean;
      } = { next: null, last: null, stopped: false };
      const done = await pinned(async () => {
        const page = await this.gateway.listIdentities({
          after: state.sync_after,
          limit: IDENTITY_PAGE,
          ...this.pin()
        });
        read.next = page?.next ?? null;
        for (const identity of page?.items ?? []) {
          // Out of time, or the pin is getting old: on from this identity
          // next run (the list goes by principal id).
          if (
            this.now() >= deadline ||
            this.now() - this.pinnedAt >= PIN_WINDOW_MS
          ) {
            read.stopped = true;
            return;
          }
          await this.isolated(
            ['principals', 'targets'],
            identity.principalId,
            report,
            async () => {
              await this.applyIdentity(identity, report, at);
              return await this.syncTargetRatings(identity, report, at);
            }
          );
          read.last = identity.principalId;
        }
      });
      if (!done) return state;
      if (read.stopped) {
        return read.last === null
          ? state
          : await this.save({ ...state, sync_after: read.last });
      }
      if (!read.next) await this.fixRowsOffTheChain(true);
      state = await this.save(
        read.next
          ? { ...state, sync_after: read.next }
          : { ...state, sync_phase: 'DELEGATIONS', sync_after: null }
      );
    }
    if (state.sync_phase === 'DELEGATIONS' && this.now() < deadline) {
      state = await this.fullSyncDelegations(state, report, from, deadline);
      if (state.sync_phase === 'DELEGATIONS') return state;
    }
    if (state.sync_phase === 'CONSOLIDATIONS' && this.now() < deadline) {
      if (!(await pinned(() => this.fullSyncPairs(state)))) return state;
      state = await this.save({
        ...state,
        // The feed went on meanwhile: it is never sent back.
        next_height: Math.max(
          Number(state.next_height ?? 0),
          Number(state.sync_from_height) + 1
        ),
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
    // Once a first full sync has written the identities; a later one runs
    // beside the feed and holds nothing back.
    const state = await this.db.getState();
    if (
      !state ||
      state.last_full_sync_at === null ||
      state.next_height === null
    ) {
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

  /**
   * Every identity's wallet pairs. An identity the mirror doesn't write
   * (merged, closing, too many wallets for a key) keeps the pairs it has.
   */
  private async fullSyncPairs(state: MirrorState) {
    const pairs: { wallet1: string; wallet2: string }[] = [];
    const keep: string[] = [];
    for (const identity of await this.allIdentities()) {
      const wallets = identity.wallets
        .map((it) => it.toLowerCase())
        .sort((a, b) => (a < b ? -1 : Number(a > b)));
      if (
        isInactive(identity) ||
        consolidationKeyOf(wallets).length > this.keyWidth
      ) {
        keep.push(...wallets);
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
        conn,
        keep
      )
    );
  }

  /**
   * Profiles that are not chain identities keep 6529.io's REP and CIC,
   * without the help bot's credits, and a level of REP + TDH: the REP once a
   * full sync has written every chain identity, the level then and after
   * each level sweep. The profile ids an identity waiting to be retried
   * could have (it may not be mapped yet) are left out; with more than
   * MAX_WAITING_LEFT_OUT of them, it waits for a later time.
   */
  private async fixRowsOffTheChain(repToo: boolean) {
    const leaveOut = await this.idsOfIdentitiesWaiting(MAX_WAITING_LEFT_OUT);
    if (!leaveOut) return;
    const fixed = await this.db.fixRowsOffTheChain({ repToo, leaveOut });
    logger.info(
      `[ROWS OFF THE CHAIN FIXED] [${fixed.rep} REP WITHOUT CREDITS] [${fixed.level} LEVELS]`
    );
  }

  /**
   * The profile ids identities waiting to be retried could have (they may
   * not be mapped yet); null with more than `limit` of them (the fix waits).
   */
  private async idsOfIdentitiesWaiting(
    limit: number
  ): Promise<string[] | null> {
    const waiting = Array.from(this.retry.principals);
    if (waiting.length > limit) {
      logger.warn(
        `[ROWS OFF THE CHAIN NOT FIXED] [${waiting.length} IDENTITIES TO RETRY]`
      );
      return null;
    }
    const ids: string[] = [];
    for (const principal of waiting) {
      try {
        const identity = await this.identity(principal);
        if (identity) ids.push(...(await this.ids.candidateIds(identity)));
      } catch (error) {
        logger.warn(`[ROWS OFF THE CHAIN NOT FIXED] ${messageOf(error)}`);
        return null;
      }
    }
    return ids;
  }

  /**
   * Each run, the next few chunks of the rows off the chain get a level of
   * REP + TDH, so their levels follow 6529.io's TDH days; the place is
   * kept, and the walk starts again from the top at the end.
   */
  private async stepLevelsOffTheChain(
    state: MirrorState
  ): Promise<MirrorState> {
    const leaveOut = await this.idsOfIdentitiesWaiting(MAX_WAITING_EACH_RUN);
    if (!leaveOut) return state;
    const step = await this.db.fixLevelsOffTheChain({
      after: state.off_chain_after ?? '',
      chunks: OFF_CHAIN_CHUNKS_A_RUN,
      leaveOut
    });
    if (step.level) {
      logger.info(`[LEVELS OFF THE CHAIN] [${step.level}]`);
    }
    return await this.save({ ...state, off_chain_after: step.after });
  }

  /**
   * Every delegation of the chain's use cases, one use case at a time, each
   * read at one height at or past `from` and written per wallet for that use
   * case, the wallets in order; the use case and the last wallet written are
   * saved, so a run cut short (the deadline, a height the node no longer
   * holds) goes on from there. Rows of other use cases go once all are
   * done; then the phase moves on.
   */
  private async fullSyncDelegations(
    initial: MirrorState,
    report: MirrorRunReport,
    from: number,
    deadline: number
  ): Promise<MirrorState> {
    let state = initial;
    const useCases = CHAIN_DELEGATION_USE_CASES;
    let index = Math.max(
      0,
      useCases.indexOf(state.sync_use_case ?? useCases[0])
    );
    while (index < useCases.length) {
      if (this.now() >= deadline) return state;
      const useCase = useCases[index];
      if (!(await this.pinReads(from))) return state;
      const wanted = new Map<string, DelegationRowWrite[]>();
      const read = await this.unlessHeightGone(async () => {
        const records = await allPages((after) =>
          this.gateway.getDelegations(
            { byUseCase: useCase },
            { after, limit: 1000, ...this.pin() }
          )
        );
        for (const record of records) {
          for (const wallet of await this.walletsOfHolder(record)) {
            const row = toDelegationRow(wallet, record);
            if (!row) continue;
            const list = wanted.get(row.from_address) ?? [];
            list.push(row);
            wanted.set(row.from_address, list);
          }
        }
      });
      if (!read) return state;
      const after = state.sync_wallet_after;
      const wallets = Array.from(
        new Set<string>([
          ...Array.from(wanted.keys()),
          ...(await this.db.walletsWithDelegations(undefined, useCase))
        ])
      )
        .filter((it) => after === null || it > after)
        .sort();
      let last: string | null = null;
      for (const wallet of wallets) {
        if (this.now() >= deadline) {
          return last === null
            ? state
            : await this.save({
                ...state,
                sync_use_case: useCase,
                sync_wallet_after: last
              });
        }
        await this.db.executeNativeQueriesInTransaction((conn) =>
          this.db.replaceWalletDelegations(
            wallet,
            wanted.get(wallet) ?? [],
            conn,
            useCase
          )
        );
        last = wallet;
        report.delegationWallets++;
      }
      index++;
      state = await this.save({
        ...state,
        sync_use_case: useCases[index] ?? null,
        sync_wallet_after: null
      });
    }
    await this.db.deleteDelegationsOutside(useCases);
    return await this.save({
      ...state,
      sync_phase: 'CONSOLIDATIONS',
      sync_use_case: null,
      sync_wallet_after: null
    });
  }

  private async walletsOfHolder(record: ChainDelegation): Promise<string[]> {
    if (record.scope === 'wallet') {
      return [record.holder.toLowerCase()];
    }
    const identity = await this.identity(record.holder);
    return identity?.wallets.map((it) => it.toLowerCase()) ?? [];
  }

  // ---------------------------------------------------------------- levels

  /** The TDH day of an identity's level, at the height it was read. */
  private noteLevel(identity: ChainIdentity | null) {
    this.noteDay(Number(identity?.level?.tdhDay), this.readAt ?? null);
  }

  /**
   * A TDH day seen at a height: the latest day, at the lowest height it was
   * seen at (null: not known).
   */
  private noteDay(day: number, height: number | null) {
    if (!Number.isSafeInteger(day)) return;
    if (day > (this.seenTdhDay ?? -1)) {
      this.seenTdhDay = day;
      this.seenTdhDayHeight = height;
    } else if (
      day === this.seenTdhDay &&
      height !== null &&
      (this.seenTdhDayHeight === null || height < this.seenTdhDayHeight)
    ) {
      this.seenTdhDayHeight = height;
    }
  }

  /**
   * The chain's current TDH day (`/v1/tdh`), once a run, so a quiet feed
   * still starts a sweep. A failure is logged: the identities read still
   * show the day.
   */
  private async readTdhDay() {
    try {
      const answer = await this.gateway.getTdh<{ day?: number }>();
      const height = Number(answer?.read?.height);
      this.noteDay(
        Number(answer?.data?.day),
        Number.isSafeInteger(height) ? height : null
      );
    } catch (error) {
      logger.warn(`[TDH DAY NOT READ] ${messageOf(error)}`);
    }
  }

  /**
   * A level changes with REP (on the feed) and with each TDH day, which
   * the feed carries no record of: a TDH day later than the last one seen,
   * on the identities this run read, starts a level sweep (again from the
   * top when one was under way).
   */
  /** An identity's level at a height; null when the node can't say. */
  private async levelAt(principal: string, height: number) {
    try {
      return (
        (await this.gateway.getIdentityByPrincipal(principal, { height }))
          ?.level ?? null
      );
    } catch (error) {
      if (isHeightGone(error)) return null;
      throw error;
    }
  }

  private async noteTdhDay(state: MirrorState): Promise<MirrorState> {
    const seen = this.seenTdhDay;
    if (seen === null || seen <= (state.levels_tdh_day ?? -1)) return state;
    logger.info(`[TDH DAY ${seen}] [SWEEPING LEVELS]`);
    return await this.save({
      ...state,
      levels_tdh_day: seen,
      levels_day_height: this.seenTdhDayHeight,
      level_sweep_day: seen,
      level_sweep_after: null
    });
  }

  /**
   * The level sweep: the chain's level ranking (its latest finalized
   * state), a page at a time to `until`, each page's level_raw written for
   * the mapped identities in one statement, and the place saved, so it goes
   * on next run. A page ranked below the height the day was first seen at,
   * or with a level of an earlier day, is from a node not there yet: the
   * sweep stops for this run without saving. Each level is the identity's
   * own as the ranking gives it (read again when it doesn't), written only
   * where no later level was. A failure stops it for this run.
   */
  private async sweepLevels(
    initial: MirrorState,
    until: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    try {
      while (state.level_sweep_day !== null && this.now() < until) {
        const page = await this.gateway.getLevelRanking({
          after: state.level_sweep_after,
          limit: LEVEL_PAGE
        });
        if (isOtherChain(state.chain_id, page.read?.network)) {
          logger.warn(
            `[LEVEL RANKING OF ANOTHER CHAIN] [${page.read?.network}] [NEXT RUN]`
          );
          return state;
        }
        const day = Number(state.level_sweep_day);
        const rankedAt = Number(page.data.rankedAt);
        // Each row's identity is read as of the answer, at or past rankedAt.
        const readAt = Math.max(Number(page.read?.height) || 0, rankedAt);
        if (
          !Number.isSafeInteger(rankedAt) ||
          rankedAt < Number(state.levels_day_height ?? 0)
        ) {
          logger.warn(
            `[LEVEL RANKING AT ${page.data.rankedAt} BEFORE DAY ${day}] [NEXT RUN]`
          );
          return state;
        }
        const rows = page.data.rows;
        const mapped = await this.db.profileIdsOfPrincipals(
          rows.map((it) => it.identity.principalId)
        );
        const levels: { profile_id: string; level_raw: number }[] = [];
        for (const row of rows) {
          const principal = row.identity.principalId.toLowerCase();
          const profileId = mapped.get(principal);
          if (!profileId) continue;
          // Read at the answer's height when it leaves the level out, so
          // every level written is as of readAt.
          const level =
            row.identity.level ?? (await this.levelAt(principal, readAt));
          if (!level) continue;
          if (Number(level.tdhDay) < day) {
            logger.warn(
              `[LEVEL OF DAY ${level.tdhDay} IN THE SWEEP OF DAY ${day}] [NEXT RUN]`
            );
            return state;
          }
          const raw = Number(level.raw);
          if (Number.isFinite(raw)) {
            levels.push({ profile_id: profileId, level_raw: raw });
          }
        }
        await this.db.writeLevels(levels, readAt);
        report.levelsSwept += levels.length;
        if (page.next) {
          state = await this.save({ ...state, level_sweep_after: page.next });
        } else {
          logger.info(`[LEVELS SWEPT FOR TDH DAY ${state.level_sweep_day}]`);
          state = await this.save({
            ...state,
            level_sweep_day: null,
            level_sweep_after: null
          });
          await this.fixRowsOffTheChain(false);
        }
      }
    } catch (error) {
      report.levelSweepProblem = messageOf(error);
      logger.error(`[LEVEL SWEEP STOPPED] ${report.levelSweepProblem}`);
    }
    return state;
  }

  // ---------------------------------------------------------------- the feed

  private async followFeed(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    // A full sync under way writes everything again anyway.
    const tooManyToRetry = (it: MirrorState) =>
      !it.sync_phase && retrySize(it.retry) > RETRY_LIMIT;
    if (tooManyToRetry(state)) {
      logger.warn(`[OVER ${RETRY_LIMIT} TO RETRY] [STARTING A FULL SYNC]`);
      return await this.startFullSync(state);
    }
    state = await this.retryFailed(state, report, deadline);
    while (this.now() < deadline) {
      const from = Number(state.next_height);
      const read = await readWholeBlocks(this.gateway, from, {
        limit: FEED_PAGE_BLOCKS,
        sleep: this.sleep
      }).catch((error: unknown) => {
        if (isWrongNetwork(error)) return 'other_chain' as const;
        throw error;
      });
      if (read === 'other_chain') {
        logger.warn(`[FEED PAGE OF ANOTHER CHAIN AT ${from}] [NEXT RUN]`);
        return state;
      }
      if (!read) {
        logger.warn(`[FEED GONE AT ${from}] [STARTING A FULL SYNC]`);
        const restarted = await this.startFullSync(state, true);
        // The full sync writes no rating events: these heights have none.
        logger.warn(
          `[NO RATING EVENTS FOR HEIGHTS ${from} TO ${Number(restarted.next_height) - 1}]`
        );
        return restarted;
      }
      if (read.atHead || read.nextHeight <= from) {
        return state;
      }
      if (!(await this.readsReach(state, read))) return state;
      // The identities a page touches are read again for each page, all at
      // one height that includes it.
      const records = read.blocks.flatMap((block) => block.records);
      // The page's rating events first, in their own transaction: its place
      // is saved after both, so a page read again writes no row twice.
      const applied = await this.unlessHeightGone(async () => {
        await this.writeRatingEvents(read.blocks, report);
        await this.applyEffects(
          feedEffects(records),
          report,
          { height: read.nextHeight - 1, source: 'FEED' },
          deadline
        );
      });
      if (!applied) return state;
      report.feedBlocks += read.blocks.length;
      state = await this.save({ ...state, next_height: read.nextHeight });
      if (tooManyToRetry(state)) {
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
    report: MirrorRunReport,
    deadline: number
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
        { height: last, source: 'FEED' },
        deadline
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
   * about 13 minutes and a page's reads take seconds. No pin goes below one
   * already used in the run, so the head going back (another node) can't
   * make a later page (of the feed or a full sync) write older state.
   */
  private async pinReads(least: number): Promise<boolean> {
    const floor = Math.max(least, this.highestPin);
    let head = await this.gateway.getHead();
    if (head.finalizedHeight < floor) head = await this.gateway.getHead(true);
    if (head.finalizedHeight < floor) {
      logger.warn(`[READS BEHIND AT ${floor}] [NEXT RUN]`);
      return false;
    }
    this.readAt = head.finalizedHeight;
    this.highestPin = head.finalizedHeight;
    this.pinnedAt = this.now();
    this.identities.clear();
    return true;
  }

  /** The pinned height for a read, when one is set. */
  private pin(): { height?: number } {
    return this.readAt === undefined ? {} : { height: this.readAt };
  }

  /**
   * Runs work whose reads are pinned; false when the gateway no longer (or
   * not yet) holds the pinned height, or answers from another chain: the run
   * stops there, to go on from the same place next time.
   */
  private async unlessHeightGone(work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (!isHeightGone(error)) throw error;
      logger.warn(
        `[PINNED READ AT ${this.readAt} REFUSED] [${messageOf(error)}] [NEXT RUN]`
      );
      return false;
    }
  }

  /**
   * Runs one key's work. A failure is logged and reported, not thrown, and
   * the key is kept to try again; a success takes it off, but for the kinds
   * the work says are left (written in part). A pinned read the gateway
   * refuses (height gone, another chain) is thrown: the whole page is read
   * again.
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
      // To the back of the list, so keys that keep failing don't hold the
      // others back.
      kinds.forEach((kind) => {
        this.retry[kind].delete(id);
        this.retry[kind].add(id);
      });
    }
  }

  /** The principals a feed page touches, with the wallets' old and new ones. */
  private async principalsOf(
    effects: FeedEffects,
    report: MirrorRunReport
  ): Promise<Set<string>> {
    const principals = new Set(effects.principals);
    if (!effects.wallets.size) {
      return principals;
    }
    const wallets = Array.from(effects.wallets);
    try {
      const now = await this.gateway.getIdentitiesByWallets(
        wallets,
        this.pin()
      );
      Object.values(now).forEach((it) => {
        if (it) principals.add(it.principalId.toLowerCase());
      });
    } catch (error) {
      if (isHeightGone(error)) throw error;
      // The records name the identities the wallets joined, and 6529.io's
      // rows the ones they left: the page goes on with those.
      const message = messageOf(error);
      logger.warn(`[WALLETS' IDENTITIES NOT READ] ${message}`);
      report.failed.push(`wallets of the page: ${message}`);
    }
    (await this.db.principalsOfWallets(wallets)).forEach((it) =>
      principals.add(it)
    );
    return principals;
  }

  /**
   * Writes what a page touched: identities, rating targets, then the
   * delegations of the wallets touched. Up to `until`, while the pin is
   * young and for at most PAGE_KEYS keys: the keys not reached go to the
   * retry list (past its limit a full sync starts), so a big page never
   * holds the feed back.
   */
  private async applyEffects(
    effects: FeedEffects,
    report: MirrorRunReport,
    at: MirrorAt,
    until: number = Number.POSITIVE_INFINITY
  ) {
    const principals = await this.principalsOf(effects, report);
    const touched = new Set<string>(effects.wallets);
    let done = 0;
    const left = { principals: 0, targets: 0, wallets: 0 };
    const room = (kind: RetryKind, key: string): boolean => {
      const now = this.now();
      if (
        done < PAGE_KEYS &&
        now < until &&
        now - this.pinnedAt < PIN_WINDOW_MS
      ) {
        done++;
        return true;
      }
      this.retry[kind].add(key.toLowerCase());
      left[kind]++;
      return false;
    };
    // Each key's reads are its own work: one that fails is tried again,
    // the others go on (a refused pin still stops the page).
    for (const principal of Array.from(principals)) {
      if (!room('principals', principal)) continue;
      await this.isolated(['principals'], principal, report, async () => {
        const identity = await this.identity(principal);
        if (!identity) return;
        (await this.applyIdentity(identity, report, at)).forEach((it) =>
          touched.add(it)
        );
      });
    }
    for (const target of Array.from(effects.ratingTargets)) {
      if (!room('targets', target)) continue;
      await this.isolated(['targets'], target, report, async () => {
        const identity = await this.identity(target);
        return identity
          ? await this.syncTargetRatings(identity, report, at)
          : [];
      });
    }
    for (const holder of Array.from(effects.delegationHolders)) {
      if (HEX20.test(holder)) {
        touched.add(holder);
        continue;
      }
      // A holder identity is done once read: its wallets go on as wallets
      // (each tried again itself when it fails).
      if (!room('wallets', holder)) continue;
      await this.isolated(['wallets'], holder, report, async () => {
        const identity = await this.identity(holder);
        identity?.wallets.forEach((it) => touched.add(it.toLowerCase()));
      });
    }
    for (const wallet of Array.from(touched)) {
      if (!room('wallets', wallet)) continue;
      await this.isolated(['wallets'], wallet, report, () =>
        this.syncWalletDelegations(wallet, report)
      );
    }
    const deferred = left.principals + left.targets + left.wallets;
    if (deferred) {
      report.deferred += deferred;
      logger.warn(
        `[PAGE AT ${at.height} WRITTEN IN PART] [${left.principals} IDENTITIES, ${left.targets} TARGETS, ${left.wallets} WALLETS LEFT TO RETRY]`
      );
    }
  }

  /**
   * The rating event rows of feed blocks: a row per Rating record, with the
   * value 6529.io had before (its ratings row, or within the page the
   * record before for the same key), the rater's and target's profile ids
   * when mapped (none is made here), the REP category's name (from the
   * blocks, the names known, else the chain's Category record at the pin)
   * and the origin from the record's writer. A record that changes nothing,
   * or of the help bot's credit category, is left out.
   */
  private async writeRatingEvents(
    blocks: readonly ChainFeedBlock[],
    report: MirrorRunReport
  ) {
    const { changes, categoryNames, unreadable } = ratingChangesOf(blocks);
    categoryNames.forEach((name, id) => this.categoryNames.set(id, name));
    if (unreadable) {
      logger.warn(`[RATING RECORDS LEFT OUT OF THE EVENTS] [${unreadable}]`);
    }
    if (!changes.length) return;
    for (const change of changes) {
      const id = change.categoryId;
      if (id === null || this.categoryNames.has(id)) continue;
      const record = await this.gateway.getState<{
        valueFields?: { name?: unknown } | null;
      }>(categoryKey(id), this.pin());
      const name = record?.valueFields?.name;
      if (typeof name !== 'string') {
        throw new Error(`No name for the REP category ${id}`);
      }
      this.categoryNames.set(id, name);
    }
    const mapped = await this.db.profileIdsOfPrincipals(
      changes.flatMap((it) => [it.rater, it.target])
    );
    const categoryOf = (it: (typeof changes)[number]) =>
      it.categoryId === null ? '' : this.categoryNames.get(it.categoryId)!;
    // 6529.io keeps NIC as CIC with the category 'CIC'.
    const rowCategory = (it: (typeof changes)[number]) =>
      it.matter === 'CIC' ? 'CIC' : categoryOf(it);
    const known = changes.flatMap((it) => {
      const rater = mapped.get(it.rater);
      const target = mapped.get(it.target);
      return rater && target
        ? [
            {
              rater_profile_id: rater,
              target_profile_id: target,
              matter: it.matter,
              matter_category: rowCategory(it)
            }
          ]
        : [];
    });
    const before = await this.db.ratingsOf(known);
    const totalsBefore = await this.db.ratingTotalsOf(
      changes.flatMap((it) => {
        const target = mapped.get(it.target);
        return target
          ? [
              {
                target_profile_id: target,
                matter: it.matter,
                matter_category: rowCategory(it)
              }
            ]
          : [];
      })
    );
    const last = new Map<string, number>();
    // The target's total in the matter and category as the page goes on.
    const totals = new Map<string, number>();
    const rows: RatingEventRow[] = [];
    for (const change of changes) {
      const category = categoryOf(change);
      if (change.matter === 'REP' && isHelpBotCreditCategory(category)) {
        continue;
      }
      const key = JSON.stringify([
        change.rater,
        change.target,
        change.matter,
        category
      ]);
      const raterProfile = mapped.get(change.rater) ?? null;
      const targetProfile = mapped.get(change.target) ?? null;
      const old =
        last.get(key) ??
        (raterProfile && targetProfile
          ? (before.get(
              ratingValueKey({
                rater_profile_id: raterProfile,
                target_profile_id: targetProfile,
                matter: change.matter,
                matter_category: rowCategory(change)
              })
            ) ?? 0)
          : 0);
      last.set(key, change.value);
      const totalKey = JSON.stringify([change.target, change.matter, category]);
      const totalBefore =
        totals.get(totalKey) ??
        (targetProfile
          ? (totalsBefore.get(
              ratingTotalKey({
                target_profile_id: targetProfile,
                matter: change.matter,
                matter_category: rowCategory(change)
              })
            ) ?? 0)
          : 0);
      const totalAfter = totalBefore + change.value - old;
      totals.set(totalKey, totalAfter);
      if (old === change.value) continue;
      rows.push({
        height: change.height,
        block_time_ms: change.blockTimeMs,
        rater_principal: change.rater,
        rater_profile_id: raterProfile,
        target_principal: change.target,
        target_profile_id: targetProfile,
        matter: change.matter,
        matter_category: category,
        old_rating: old,
        new_rating: change.value,
        total_after: totalAfter,
        origin: ratingEventOrigin(change.writer, change.byImport),
        by_import: change.byImport,
        writer: writerText(change.writer)
      });
    }
    report.ratingEvents += await this.db.insertRatingEvents(rows, this.now());
  }

  // ---------------------------------------------------------------- one identity

  private async identity(principalId: string): Promise<ChainIdentity | null> {
    const key = principalId.toLowerCase();
    if (!this.identities.has(key)) {
      const identity = await this.gateway.getIdentityByPrincipal(
        key,
        this.pin()
      );
      this.noteLevel(identity);
      this.identities.set(key, identity);
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
      const problems: string[] = [];
      const fields = toProfileDocFields(decodeProfileDoc(bytes), problems);
      problems.forEach((it) =>
        report.docProblems.push(`${identity.principalId}: ${it}`)
      );
      return fields;
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
    this.noteLevel(identity);
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
      // An imported one is mapped all the same, so its 6529.io row isn't
      // taken for a profile off the chain.
      if (identity.legacyId) await this.profileIdOf(identity);
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
        // A level read below the height of the last one written (a sweep's)
        // isn't written over it: the row keeps its own.
        const readHeight = this.readAt ?? at.height;
        const levelHeight = await this.db.levelHeightOf(view.principalId, conn);
        const levelFresh = levelHeight === null || readHeight >= levelHeight;
        const plan = planIdentity(
          levelFresh ? view : { ...view, levelRaw: null },
          state
        );
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
        if (plan.regroupedWallets.length) {
          await this.db.queueRegroups(plan.regroupedWallets, this.now(), conn);
        }
        if (levelFresh && view.levelRaw !== null) {
          await this.db.setLevelHeight(view.principalId, readHeight, conn);
        }
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
   * whose profile id can't be settled yet is left as it is (the rows under
   * the ids it could get stay), the others are written, removals included,
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
    const keepRaters: string[] = [];
    // Mapped raters by their mapping, in one read; an identity is read only
    // for a rater with none.
    const mapped = await this.db.profileIdsOfPrincipals(
      ratings.map((it) => it.rater)
    );
    for (const rating of ratings) {
      let raterProfileId = mapped.get(rating.rater.toLowerCase());
      if (!raterProfileId) {
        const rater = await this.identity(rating.rater);
        if (!rater) continue;
        try {
          // A merged or closed rater is named without storing a mapping.
          raterProfileId = isInactive(rater)
            ? (await this.profileIdForSites(rater)).profileId
            : await this.profileIdOf(rater);
        } catch (error) {
          if (!(error instanceof ChainReadRetryLater)) throw error;
          unsettled.push(rater.principalId);
          keepRaters.push(...(await this.ids.candidateIds(rater)));
          continue;
        }
      }
      const row = this.ratingRow(rating, raterProfileId);
      if (row) rows.push(row);
    }
    if (unsettled.length) {
      logger.warn(
        `[RATERS NOT SETTLED] [${identity.principalId}] [${unsettled.join(', ')}] [TRIED AGAIN]`
      );
    }
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceTargetRatings(targetProfileId, rows, this.now(), conn, {
        keepRaters
      })
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
