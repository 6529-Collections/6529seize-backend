import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainFeedPage
} from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import { Time } from '@/time';
import { compareCodeUnits } from './waves-chain-index.order';
import {
  ChainObject,
  GatewayWavesChainApi,
  repeatedCursor,
  WavesChainApi
} from './waves-chain-index.api';
import {
  claimBuildQueue,
  ClaimBuildPort,
  claimBuildsOf
} from './waves-chain-index.claims';
import {
  EMPTY_INDEX_STATE,
  IndexTableName,
  RowStamp,
  VoteRereads,
  WavesChainIndexDb,
  wavesChainIndexDb,
  WavesChainIndexState
} from './waves-chain-index.db';
import {
  BatchObject,
  batchObjects,
  deriveEvents,
  emptyEventContext,
  EVENT_ONLY_FAMILIES,
  EventCarry,
  EventContext,
  eventLookups,
  gapEvent,
  ObjectInfo,
  UNKNOWN_SCAN,
  VoteTrust
} from './waves-chain-index.events';
import {
  emptyFeedEffects,
  FeedEffects,
  feedEffects,
  splitFeedEffects,
  WAVES_FEED_FAMILIES
} from './waves-chain-index.feed';
import {
  decisionRow,
  entryRow,
  groupRow,
  IndexRow,
  leaderboardEntryRows,
  leaderboardRow,
  pollRow,
  resultRow,
  roleRow,
  voteRow,
  waveRepRow,
  waveRow
} from './waves-chain-index.rows';

const logger = Logger.get('WAVES_CHAIN_INDEX');

/**
 * 6529.io's index of the 6529 chain's waves (entities/IWavesChainIndex.ts).
 *
 * Each run pins every read to one finalized height H, never below the last
 * run's, and does in order, each to the run's deadline:
 * 1. the change feed from the cursor up to H: every object a record touched
 *    is read again at H (vote records are applied as they are);
 * 2. what moves with block time alone: live counted decisions (`due`) and
 *    their leaderboards, role grants past their expiry, stalest first;
 * 3. a full read in progress: groups, then waves (roles, polls, wave REP),
 *    then decisions (results, leaderboard, entries, each entry's votes),
 *    then the rows it did not see are removed.
 * The first full read starts the feed at its first height + 1, so the feed
 * replays what changed while the full read went on. A full read runs again
 * every day, and at once when the gateway no longer holds the feed from the
 * cursor. It reads at the feed's height when the feed trails the run's
 * (a lower read is safe: a row read lower than the stored one changes only
 * its generation), so no row is read past a block the feed has still to
 * apply: the event log takes what was there before a block from the rows.
 * A new network id (a relaunched chain) empties the index and the log
 * first. Nothing runs before the chain's waves import completes.
 *
 * Each feed batch's events (waves-chain-index.events.ts) are written before
 * the batch is applied, from the index as it stood before it, with the
 * height the log has reached: chain_events. When the feed no longer holds
 * the cursor, a GAP event says which heights the log lacks.
 */

export const FULL_READ_EVERY_MS = Time.hours(24).toMillis();

export const FULL_PHASES = ['groups', 'waves', 'decisions', 'sweep'] as const;
export type FullPhase = (typeof FULL_PHASES)[number];

/** Feed records are applied in batches of about this many reads. */
const BATCH_READS = 100;
/** Reads in flight at once. */
const READ_CONCURRENCY = 8;
/** Claim builds a run sends at most. */
const CLAIM_SENDS_PER_RUN = 20;
/** A feed read answered `gone` is asked again this many times first. */
const GONE_RETRIES = 2;
/**
 * A full read reads at most this far below the run's height, at the feed's
 * height (the nodes keep 64); further behind, it waits for the feed.
 */
const MAX_FULL_TRAIL = 32;
/** What the feed is asked for: the index's families and the log's. */
const FEED_FAMILIES: readonly string[] = [
  ...WAVES_FEED_FAMILIES,
  ...EVENT_ONLY_FAMILIES
];

export interface WavesChainIndexReport {
  mode: 'idle' | 'skipped' | 'indexed';
  skipped?: 'import_not_complete' | 'gateway_behind' | 'head_time_unknown';
  height: number | null;
  feedFrom: number | null;
  feedNext: number | null;
  feedBatches: number;
  reread: Record<string, number>;
  votes: number;
  /** Events written to the log. */
  events: number;
  /** Main Stage claim builds queued (written), sent, failed to send. */
  claimBuilds: { queued: number; sent: number; failed: number };
  /** Leaderboard rows written or deleted (only the ones that moved). */
  leaderboardRows: number;
  timeDependent: number;
  full: {
    generation: number;
    phase: string | null;
    started: boolean;
    /** A full read under way waited for the feed to reach the height. */
    waitingForFeed: boolean;
    items: number;
    completed: boolean;
    swept: Record<string, number> | null;
  };
  restartedFull: 'feed_gone' | 'network_changed' | null;
}

function idOf(object: ChainObject | null, field: string): string | null {
  const value = object?.[field];
  return typeof value === 'string' && value ? value.toLowerCase() : null;
}

function legacyIdOf(object: ChainObject): string | null {
  return idOf(object, 'legacyId');
}

function numberOf(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || !Number.isSafeInteger(number)
    ? null
    : number;
}

/**
 * Whether the full read under way has read the votes of this entry (its
 * decisions go by id, each decision's entries by id).
 */
export function fullReadCovers(
  state: Pick<WavesChainIndexState, 'fullPhase' | 'fullAfter'>,
  decisionId: string,
  entryId: string
): boolean {
  if (state.fullPhase === 'sweep') return true;
  if (state.fullPhase !== 'decisions') return false;
  const cursor = splitCursor(state.fullAfter);
  if (!cursor.decisionId || decisionId > cursor.decisionId) return false;
  if (decisionId < cursor.decisionId || !cursor.inProgress) return true;
  return cursor.entryAfter !== null && entryId <= cursor.entryAfter;
}

/** Runs `fn` over `items`, at most `limit` at once. */
async function eachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** The reads a batch of feed effects costs, roughly. */
function readsOf(effects: FeedEffects): number {
  return (
    effects.groups.size +
    effects.waves.size +
    effects.roleWaves.size +
    effects.repWaves.size +
    effects.polls.size +
    effects.decisions.size +
    effects.entries.size +
    effects.results.size +
    effects.voteEntries.size +
    effects.leaderboards.size
  );
}

/**
 * The full read's decision cursor: `id` when that decision is done,
 * `id:` once its decision, results and board are, `id:entryId` once its
 * entries up to entryId are.
 */
export function splitCursor(after: string | null): {
  decisionId: string | null;
  inProgress: boolean;
  entryAfter: string | null;
} {
  if (!after) return { decisionId: null, inProgress: false, entryAfter: null };
  const colon = after.indexOf(':');
  if (colon < 0) {
    return { decisionId: after, inProgress: false, entryAfter: null };
  }
  return {
    decisionId: after.slice(0, colon),
    inProgress: true,
    entryAfter: after.slice(colon + 1) || null
  };
}

export class WavesChainIndex {
  constructor(
    private readonly api: WavesChainApi,
    private readonly db: WavesChainIndexDb,
    private readonly now: () => number = () => Date.now(),
    private readonly fullEveryMs: number = FULL_READ_EVERY_MS,
    private readonly claims: ClaimBuildPort = claimBuildQueue
  ) {}

  async run({
    budgetMs
  }: {
    budgetMs: number;
  }): Promise<WavesChainIndexReport> {
    const deadline = this.now() + budgetMs;
    let state = await this.db.loadState();
    const report: WavesChainIndexReport = {
      mode: 'idle',
      height: null,
      feedFrom: state.feedNext,
      feedNext: state.feedNext,
      feedBatches: 0,
      reread: {},
      votes: 0,
      events: 0,
      claimBuilds: { queued: 0, sent: 0, failed: 0 },
      leaderboardRows: 0,
      timeDependent: 0,
      full: {
        generation: state.generation,
        phase: state.fullPhase,
        started: false,
        waitingForFeed: false,
        items: 0,
        completed: false,
        swept: null
      },
      restartedFull: null
    };
    const head = await this.api.head();
    const height = head.finalizedHeight;
    report.height = height;
    if (head.network && state.network && head.network !== state.network) {
      // Another chain: none of the rows are its.
      logger.warn(
        `[NETWORK ${state.network} -> ${head.network}] emptying the index`
      );
      await this.db.clearAll();
      state = await this.save({
        ...EMPTY_INDEX_STATE,
        generation: state.generation,
        network: head.network
      });
      report.restartedFull = 'network_changed';
    }
    const imported = await this.api.importState(height);
    if (!imported?.completed) {
      report.mode = 'skipped';
      report.skipped = 'import_not_complete';
      return report;
    }
    if (state.readHeight !== null && height < state.readHeight) {
      // A node behind the one the last run read from: reading at its
      // height would take rows back.
      report.mode = 'skipped';
      report.skipped = 'gateway_behind';
      return report;
    }
    if (head.finalizedTime === null) {
      // Neither the status nor /v1/blocks/{height} gave the pinned block's
      // time, so what moves with time can't be judged at it. Wait for the
      // next run rather than guess.
      report.mode = 'skipped';
      report.skipped = 'head_time_unknown';
      return report;
    }
    report.mode = 'indexed';
    state = await this.save({
      ...state,
      readHeight: height,
      network: head.network ?? state.network,
      // The import's start, kept from the first run that read it complete.
      importStartedAt: state.importStartedAt ?? imported.startedAt
    });
    try {
      const fullDue =
        state.lastFullAt !== null &&
        this.now() - state.lastFullAt > this.fullEveryMs;
      if (state.feedNext === null || (!state.fullPhase && fullDue)) {
        state = await this.startFull(state, height, false, report);
      }
      state = await this.followFeed(state, height, deadline, report);
      await this.sendClaimBuilds(report);
      // At most half of what is left, so a full read keeps moving.
      const left = Math.max(0, deadline - this.now());
      await this.refreshTimeDependent(
        state,
        height,
        head.finalizedTime,
        this.now() + left / 2,
        report
      );
      if (state.fullPhase) {
        // Rows read above the feed's height would hold changes the feed
        // has still to log: the full read reads at the feed's height.
        const readAt = Math.min(height, (state.feedNext as number) - 1);
        if (height - readAt <= MAX_FULL_TRAIL) {
          state = await this.continueFull(
            state,
            readAt,
            deadline,
            report,
            height
          );
        } else {
          report.full.waitingForFeed = true;
        }
      }
      if (state.lastError !== null) {
        state = await this.save({ ...state, lastError: null });
      }
    } catch (error) {
      if (error instanceof ChainGatewayError && error.code === 'gone') {
        // The feed no longer goes back to the cursor: what changed since is
        // only in the chain's state now. Read it all again from H.
        const current = await this.db.loadState();
        logger.warn(
          `[FEED GONE FROM ${current.feedNext}] full read from ${height}`
        );
        report.restartedFull = 'feed_gone';
        // The log says which heights it lacks; the scan's state is unknown
        // again.
        const from = Math.max(current.feedNext ?? 0, current.eventsNext ?? 0);
        if (from <= height) {
          await this.db.writeEvents(
            [gapEvent(from, height, head.finalizedTime)],
            height + 1,
            UNKNOWN_SCAN
          );
          report.events++;
          const mainStage = this.claims.enabled()
            ? Array.from(this.claims.mainStage())
            : [];
          if (mainStage.length) {
            // A Main Stage result that went final in the gap has no event,
            // so no claim build: a person checks (an error alarms).
            logger.error(
              `[CLAIM BUILD GAP] the event log lacks heights ${from} to ${height}: a Main Stage result that went final there got no claim build. Check the results of ${mainStage.join(', ')} (GET /v1/decisions/{id}/results) and send any missing build by hand.`
            );
          }
        }
        await this.startFull(
          {
            ...current,
            eventsNext: Math.max(current.eventsNext ?? 0, height + 1),
            scanState: UNKNOWN_SCAN
          },
          height,
          true,
          report
        );
        return report;
      }
      await this.save({
        ...(await this.db.loadState()),
        lastError: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    report.feedNext = state.feedNext;
    report.full.generation = state.generation;
    report.full.phase = state.fullPhase;
    return report;
  }

  private async save(
    state: WavesChainIndexState
  ): Promise<WavesChainIndexState> {
    await this.db.saveState(state, this.now());
    return state;
  }

  private async startFull(
    state: WavesChainIndexState,
    height: number,
    feedGone: boolean,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    report.full.started = true;
    report.full.generation = state.generation + 1;
    report.full.phase = FULL_PHASES[0];
    logger.info(
      `[FULL READ ${state.generation + 1} FROM HEIGHT ${height}${feedGone ? ', FEED GONE' : ''}]`
    );
    // From empty, or past a gap in the feed, no row tells an event what was
    // there before a block until this full read has read it again; nor
    // when it takes over from such a full read that did not end.
    const restart = feedGone || state.feedNext === null;
    const checking =
      state.fullPhase !== null && state.trustFrom === state.generation;
    return this.save({
      ...state,
      generation: state.generation + 1,
      fullPhase: FULL_PHASES[0],
      fullAfter: null,
      fullFromHeight: height,
      feedNext: restart ? height + 1 : state.feedNext,
      // Parts done of a block before the new cursor count for nothing past it.
      feedPart: restart ? 0 : state.feedPart,
      trustFrom: restart || checking ? state.generation + 1 : state.trustFrom
    });
  }

  private count(report: WavesChainIndexReport, table: string, n = 1) {
    report.reread[table] = (report.reread[table] ?? 0) + n;
  }

  // ---------------------------------------------------------------- feed

  private async readFeed(from: number): Promise<ChainFeedPage> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api.feed(from, FEED_FAMILIES);
      } catch (error) {
        // One node behind the gateway may hold less than another.
        if (
          !(error instanceof ChainGatewayError && error.code === 'gone') ||
          attempt >= GONE_RETRIES
        ) {
          throw error;
        }
      }
    }
  }

  /**
   * Applies the feed from the cursor up to H in batches of about
   * BATCH_READS reads, each batch's events logged first, saving the cursor
   * after each, until the deadline. A block with more than that is a batch
   * of its own, applied in parts with the deadline checked between them; a
   * run that stops inside it saves the parts done (feedPart), and the next
   * goes on from there. Entries whose vote records the node could not
   * decode are kept in the state with those votes (unknown to the log until
   * then), and their votes are read whole at the height the feed has
   * reached, so no vote row is read past a block the log has still to
   * derive.
   */
  private async followFeed(
    initial: WavesChainIndexState,
    height: number,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    let next = state.feedNext as number;
    const stamp = { height, generation: state.generation };
    const carry: { value: EventCarry } = {
      value: {
        scan: state.scanState,
        unknownVotes: new Set(state.voteRereads.votes)
      }
    };
    const reread = new Set<string>(state.voteRereads.entries);
    const rereads = () => ({
      entries: Array.from(reread).sort(compareCodeUnits),
      votes: Array.from(carry.value.unknownVotes).sort(compareCodeUnits)
    });
    feed: while (next <= height && this.now() < deadline) {
      const page = await this.readFeed(next);
      const pageNext = Number.isSafeInteger(Number(page.next))
        ? Number(page.next)
        : Number(page.through) + 1;
      // Only what the run's reads can see: heights up to H.
      const end = Math.min(pageNext, height + 1);
      if (!(end > next)) break;
      const blocks = page.blocks
        .filter((block) => block.height >= next && block.height < end)
        .sort((a, b) => a.height - b.height);
      let batch = emptyFeedEffects();
      let batchBlocks: ChainFeedBlock[] = [];
      const apply = async (to: number) => {
        state = await this.logEvents(
          state,
          batchBlocks,
          to,
          height,
          report,
          carry
        );
        await this.applyEffects(batch, stamp, report, reread);
        batch = emptyFeedEffects();
        batchBlocks = [];
        next = to;
        state = await this.save({
          ...state,
          feedNext: next,
          feedPart: 0,
          voteRereads: rereads()
        });
      };
      for (const block of blocks) {
        const own = feedEffects({ blocks: [block] });
        if (readsOf(own) > BATCH_READS) {
          // What came before it first; a run resuming it starts at it.
          if (next < block.height) await apply(block.height);
          // Its events first, once: a block resumed has them logged.
          batchBlocks = [block];
          state = await this.logEvents(
            state,
            batchBlocks,
            block.height + 1,
            height,
            report,
            carry
          );
          batchBlocks = [];
          const done = await this.applyBlockInParts(
            state,
            block,
            own,
            stamp,
            deadline,
            report,
            reread,
            rereads
          );
          state = done.state;
          next = state.feedNext as number;
          if (!done.finished || this.now() >= deadline) break feed;
          continue;
        }
        feedEffects({ blocks: [block] }, batch);
        batchBlocks.push(block);
        if (readsOf(batch) >= BATCH_READS && block.height + 1 < end) {
          await apply(block.height + 1);
          if (this.now() >= deadline) break feed;
        }
      }
      await apply(end);
    }
    // A run stopped inside a block has applied some of its vote records:
    // the votes are read again once the block is.
    return state.feedPart > 0
      ? state
      : this.rereadVotes(state, next - 1, height, carry, reread, report);
  }

  /**
   * Reads whole, at `at` (the height the feed has reached), the votes of
   * the entries whose vote records the node could not decode, and takes
   * their votes off the unknown ones. When the feed is too far behind the
   * head for the nodes to answer at its height, they wait for a later run.
   */
  private async rereadVotes(
    initial: WavesChainIndexState,
    at: number,
    height: number,
    carry: { value: EventCarry },
    reread: Set<string>,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    if (!reread.size || height - at > MAX_FULL_TRAIL) return initial;
    const stamp = { height: at, generation: initial.generation };
    const entries = Array.from(reread);
    await eachLimit(entries, READ_CONCURRENCY, async (entryId) => {
      const votes = await this.api.entryVotes(entryId, at);
      await this.db.replaceChildren(
        'votes',
        'entry_id',
        entryId,
        (votes ?? []).map(voteRow),
        stamp
      );
      this.count(report, 'votes');
    });
    const unknown = new Set(carry.value.unknownVotes);
    for (const key of Array.from(unknown)) {
      if (reread.has(key.split(':')[1])) unknown.delete(key);
    }
    carry.value = { ...carry.value, unknownVotes: unknown };
    for (const entryId of entries) reread.delete(entryId);
    return this.save({
      ...initial,
      voteRereads: {
        entries: Array.from(reread).sort(compareCodeUnits),
        votes: Array.from(unknown).sort(compareCodeUnits)
      }
    });
  }

  // ---------------------------------------------------------- the event log

  /**
   * Writes the events of a batch's blocks (those up to `end`, exclusive)
   * that the log doesn't hold yet, before the batch is applied: the index
   * then still holds what was there before. A batch the log holds (a run
   * that stopped after logging it) is skipped.
   */
  private async logEvents(
    state: WavesChainIndexState,
    blocks: readonly ChainFeedBlock[],
    end: number,
    height: number,
    report: WavesChainIndexReport,
    carry: { value: EventCarry }
  ): Promise<WavesChainIndexState> {
    if (!blocks.length) return state;
    const from = state.eventsNext ?? 0;
    // Logged before: only what the blocks carry to the next ones is needed.
    const logged = end <= from;
    const context = logged
      ? emptyEventContext()
      : await this.eventContext(blocks, height, report);
    const derived = deriveEvents(
      blocks,
      from,
      context,
      this.voteTrust(state),
      carry.value
    );
    carry.value = derived.carry;
    if (logged) return state;
    // Main Stage claim builds, written with the events that call for them.
    const builds = this.claims.enabled()
      ? claimBuildsOf(derived.events, this.claims.mainStage(), state.network)
      : [];
    await this.db.writeEvents(derived.events, end, derived.carry.scan, builds);
    report.events += derived.events.length;
    report.claimBuilds.queued += builds.filter(
      (build) => build.status === 'pending'
    ).length;
    return { ...state, eventsNext: end, scanState: derived.carry.scan };
  }

  /**
   * Sends the claim builds the log has written and not sent, oldest first;
   * a failed send stays for the next run (waves-chain-index.claims.ts).
   */
  private async sendClaimBuilds(report: WavesChainIndexReport) {
    if (!this.claims.enabled()) return;
    const pending = await this.db.pendingClaimBuilds(CLAIM_SENDS_PER_RUN);
    for (const build of pending) {
      const key = {
        network: build.network,
        decisionId: build.decisionId,
        occurrence: build.occurrence
      };
      let messageId: string | null;
      try {
        messageId = await this.claims.send(build.message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `[CLAIM BUILD SEND FAILED] decision ${build.decisionId} occurrence ${build.occurrence}, attempt ${build.attempts + 1}: ${message}`
        );
        await this.db.claimBuildFailed(key, message);
        report.claimBuilds.failed++;
        continue;
      }
      await this.db.claimBuildSent(key, messageId, this.now());
      report.claimBuilds.sent++;
    }
  }

  /** What the votes in the index tell an event (see VoteTrust). */
  private voteTrust(state: WavesChainIndexState): VoteTrust {
    const lastComplete = state.fullPhase
      ? state.generation - 1
      : state.generation;
    return {
      complete: lastComplete >= state.trustFrom,
      generation: state.generation,
      trustFrom: state.trustFrom,
      covers: (decisionId, entryId) =>
        fullReadCovers(state, decisionId, entryId)
    };
  }

  /**
   * The index's objects, votes and the log's last ballots for a batch's
   * events. An object the index doesn't hold yet is taken from the batch's
   * records when created on the chain (no legacy id), else read at the
   * run's height (its legacy id and parents never change).
   */
  private async eventContext(
    blocks: readonly ChainFeedBlock[],
    at: number,
    report: WavesChainIndexReport
  ): Promise<EventContext> {
    const lookups = eventLookups(blocks);
    const own = batchObjects(blocks);
    const known = await this.db.eventObjects({
      entries: Array.from(lookups.entryIds),
      polls: Array.from(lookups.pollIds),
      groups: Array.from(lookups.groupIds)
    });
    const fill = async (
      ids: Iterable<string>,
      into: Map<string, ObjectInfo>,
      batch: Map<string, BatchObject>,
      read: (id: string) => Promise<ObjectInfo | null>
    ) => {
      const missing = Array.from(new Set(ids)).filter((id) => !into.has(id));
      await eachLimit(missing, READ_CONCURRENCY, async (id) => {
        const mine = batch.get(id);
        const info = mine?.native ? mine : ((await read(id)) ?? mine);
        if (info) into.set(id, info);
      });
    };
    const reading =
      <T>(
        read: (id: string) => Promise<T | null>,
        to: (object: T) => ObjectInfo
      ) =>
      async (id: string) => {
        this.count(report, 'eventObjects');
        const object = await read(id);
        return object ? to(object) : null;
      };
    await fill(
      lookups.entryIds,
      known.entries,
      own.entries,
      reading(
        (id) => this.api.entry(id, at),
        (entry) => ({
          legacyId: legacyIdOf(entry),
          decisionId: idOf(entry, 'decisionId'),
          author: idOf(entry, 'author'),
          total: typeof entry.total === 'string' ? entry.total : null
        })
      )
    );
    await fill(
      lookups.groupIds,
      known.groups,
      own.groups,
      reading(
        (id) => this.api.group(id, at),
        (group) => ({ legacyId: legacyIdOf(group) })
      )
    );
    await fill(
      lookups.pollIds,
      known.polls,
      own.polls,
      reading(
        (id) => this.api.poll(id, at),
        (poll) => ({ legacyId: legacyIdOf(poll), waveId: idOf(poll, 'waveId') })
      )
    );
    // Then the decisions they name, then the waves those name.
    const decisionIds = new Set(lookups.decisionIds);
    for (const entry of Array.from(known.entries.values())) {
      if (entry.decisionId) decisionIds.add(entry.decisionId);
    }
    const { decisions } = await this.db.eventObjects({
      decisions: Array.from(decisionIds)
    });
    await fill(
      decisionIds,
      decisions,
      own.decisions,
      reading(
        (id) => this.api.decision(id, at),
        (decision) => {
          const config = (decision.config ?? {}) as ChainObject;
          return {
            legacyId: legacyIdOf(decision),
            waveId: idOf(decision, 'waveId'),
            creditScope: numberOf(config.creditScope),
            creditSource: numberOf(config.creditSource),
            status:
              typeof decision.status === 'string' ? decision.status : null,
            statusHeight: at
          };
        }
      )
    );
    const waveIds = new Set(lookups.waveIds);
    for (const info of [
      ...Array.from(decisions.values()),
      ...Array.from(known.polls.values())
    ]) {
      if (info.waveId) waveIds.add(info.waveId);
    }
    const { waves } = await this.db.eventObjects({
      waves: Array.from(waveIds)
    });
    await fill(
      waveIds,
      waves,
      own.waves,
      reading(
        (id) => this.api.wave(id, at),
        (wave) => ({ legacyId: legacyIdOf(wave) })
      )
    );
    return {
      entries: known.entries,
      decisions,
      waves,
      polls: known.polls,
      groups: known.groups,
      votes: await this.db.eventVotes(Array.from(lookups.votes.values())),
      ballots: await this.db.lastBallots(
        Array.from(lookups.ballots.values()),
        blocks[0].height
      )
    };
  }

  /**
   * A block too large for one batch, in parts (the same parts on every
   * run), from the one the last run stopped at; one part a run at least.
   */
  private async applyBlockInParts(
    initial: WavesChainIndexState,
    block: ChainFeedBlock,
    effects: FeedEffects,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport,
    reread: Set<string>,
    rereads: () => VoteRereads
  ): Promise<{ state: WavesChainIndexState; finished: boolean }> {
    let state = initial;
    const parts = splitFeedEffects(effects, BATCH_READS);
    const from =
      state.feedNext === block.height
        ? Math.min(state.feedPart, parts.length)
        : 0;
    for (let k = from; k < parts.length; k++) {
      await this.applyEffects(parts[k], stamp, report, reread);
      if (k + 1 < parts.length) {
        state = await this.save({
          ...state,
          feedNext: block.height,
          feedPart: k + 1,
          voteRereads: rereads()
        });
        if (this.now() >= deadline) return { state, finished: false };
      }
    }
    state = await this.save({
      ...state,
      feedNext: block.height + 1,
      feedPart: 0,
      voteRereads: rereads()
    });
    return { state, finished: true };
  }

  /** Reads one object again: its row, or none when the chain has none. */
  private async refreshOne(
    table: IndexTableName,
    object: ChainObject | null,
    toRow: (object: ChainObject) => IndexRow,
    keyRow: IndexRow,
    stamp: RowStamp,
    report: WavesChainIndexReport
  ): Promise<ChainObject | null> {
    if (object) {
      await this.db.upsert(table, [toRow(object)], stamp);
    } else {
      await this.db.remove(table, [keyRow]);
    }
    this.count(report, table);
    return object;
  }

  /**
   * Applies a batch. The entries whose vote records the node could not
   * decode are added to `reread`: the caller reads their votes whole once
   * the feed has reached the run's height.
   */
  private async applyEffects(
    effects: FeedEffects,
    stamp: RowStamp,
    report: WavesChainIndexReport,
    reread: Set<string>
  ): Promise<void> {
    if (!readsOf(effects) && !effects.votes.size) return;
    report.feedBatches++;
    const at = stamp.height;
    await eachLimit(
      Array.from(effects.groups),
      READ_CONCURRENCY,
      async (id) => {
        await this.refreshOne(
          'groups',
          await this.api.group(id, at),
          groupRow,
          { group_id: id },
          stamp,
          report
        );
      }
    );
    await eachLimit(Array.from(effects.waves), READ_CONCURRENCY, async (id) => {
      await this.refreshOne(
        'waves',
        await this.api.wave(id, at),
        waveRow,
        { wave_id: id },
        stamp,
        report
      );
    });
    await eachLimit(
      Array.from(effects.roleWaves),
      READ_CONCURRENCY,
      async (waveId) => {
        await this.replaceRoles(waveId, stamp);
        this.count(report, 'roles');
      }
    );
    await eachLimit(
      Array.from(effects.repWaves),
      READ_CONCURRENCY,
      async (waveId) => {
        await this.replaceWaveRep(waveId, stamp);
        this.count(report, 'waveRep');
      }
    );
    const decisions = new Map<string, ChainObject | null>();
    await eachLimit(
      Array.from(effects.decisions),
      READ_CONCURRENCY,
      async (id) => {
        decisions.set(
          id,
          await this.refreshOne(
            'decisions',
            await this.api.decision(id, at),
            decisionRow,
            { decision_id: id },
            stamp,
            report
          )
        );
      }
    );
    const leaderboards = new Set(Array.from(effects.leaderboards));
    await eachLimit(
      Array.from(effects.entries),
      READ_CONCURRENCY,
      async (id) => {
        const entry = await this.refreshOne(
          'entries',
          await this.api.entry(id, at),
          entryRow,
          { entry_id: id },
          stamp,
          report
        );
        const decisionId = idOf(entry, 'decisionId');
        if (decisionId) leaderboards.add(decisionId);
      }
    );
    // Results: a decision's, or a closed poll's (one family on the chain).
    const results = Array.from(effects.results.values());
    const stored = await this.db.decisionStatuses(results.map((r) => r.id));
    const polls = new Set(Array.from(effects.polls));
    await eachLimit(results, READ_CONCURRENCY, async ({ id, resultTime }) => {
      const isDecision = decisions.has(id)
        ? decisions.get(id) !== null
        : stored.has(id) || (await this.api.decision(id, at)) !== null;
      if (!isDecision) {
        polls.add(id);
        return;
      }
      await this.refreshOne(
        'results',
        await this.api.result(id, resultTime, at),
        (result) => resultRow(id, result),
        { decision_id: id, result_time: resultTime },
        stamp,
        report
      );
    });
    await eachLimit(Array.from(polls), READ_CONCURRENCY, async (id) => {
      await this.refreshOne(
        'polls',
        await this.api.poll(id, at),
        pollRow,
        { poll_id: id },
        stamp,
        report
      );
    });
    for (const entryId of Array.from(effects.voteEntries)) reread.add(entryId);
    const votes = Array.from(effects.votes.values());
    if (votes.length) {
      await this.db.applyVotes(votes, stamp);
      report.votes += votes.length;
    }
    await this.refreshLeaderboards(
      Array.from(leaderboards),
      decisions,
      stamp,
      report
    );
  }

  /**
   * Boards of published decisions are kept; another decision's board is
   * removed (its scores, if any, keep moving with time and nothing reads
   * them).
   */
  private async refreshLeaderboards(
    ids: readonly string[],
    known: Map<string, ChainObject | null>,
    stamp: RowStamp,
    report: WavesChainIndexReport
  ): Promise<void> {
    const stored = await this.db.decisionStatuses(
      ids.filter((id) => !known.has(id))
    );
    await eachLimit(ids, READ_CONCURRENCY, async (id) => {
      const status = known.has(id)
        ? ((known.get(id)?.status as string | undefined) ?? null)
        : (stored.get(id)?.status ?? null);
      await this.refreshLeaderboard(id, status === 'published', stamp, report);
      this.count(report, 'leaderboards');
    });
  }

  private async refreshLeaderboard(
    decisionId: string,
    published: boolean,
    stamp: RowStamp,
    report: WavesChainIndexReport
  ) {
    const leaderboard = published
      ? await this.api.decisionLeaderboard(decisionId, stamp.height)
      : null;
    if (leaderboard) {
      await this.db.upsert(
        'leaderboards',
        [leaderboardRow(decisionId, leaderboard)],
        stamp
      );
    } else {
      await this.db.remove('leaderboards', [{ decision_id: decisionId }]);
    }
    report.leaderboardRows += await this.db.writeLeaderboardRows(
      decisionId,
      leaderboard ? leaderboardEntryRows(decisionId, leaderboard) : [],
      stamp
    );
  }

  private async replaceRoles(waveId: string, stamp: RowStamp) {
    const roles = (await this.api.waveRoles(waveId, stamp.height)) ?? [];
    await this.db.replaceChildren(
      'roles',
      'wave_id',
      waveId,
      roles.map((role) => roleRow(waveId, role)),
      stamp
    );
  }

  private async replaceWaveRep(waveId: string, stamp: RowStamp) {
    const ratings = (await this.api.waveRep(waveId, stamp.height)) ?? [];
    await this.db.replaceChildren(
      'waveRep',
      'wave_id',
      waveId,
      ratings.map((rating) => waveRepRow(waveId, rating)),
      stamp
    );
  }

  private async replacePolls(waveId: string, stamp: RowStamp) {
    const polls = (await this.api.wavePolls(waveId, stamp.height)) ?? [];
    await this.db.replaceChildren(
      'polls',
      'wave_id',
      waveId,
      polls.map(pollRow),
      stamp
    );
  }

  // ---------------------------------------------------------- time moves

  private async refreshTimeDependent(
    state: WavesChainIndexState,
    height: number,
    blockTime: number,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<void> {
    const stamp = { height, generation: state.generation };
    const { decisionIds, roleWaveIds } = await this.db.timeDependent(blockTime);
    const work: (() => Promise<void>)[] = [
      ...decisionIds.map((id) => async () => {
        const decision = await this.refreshOne(
          'decisions',
          await this.api.decision(id, height),
          decisionRow,
          { decision_id: id },
          stamp,
          report
        );
        // A live counted decision's scores move with its block time.
        await this.refreshLeaderboard(
          id,
          decision?.status === 'published',
          stamp,
          report
        );
        this.count(report, 'leaderboards');
      }),
      ...roleWaveIds.map((waveId) => async () => {
        await this.replaceRoles(waveId, stamp);
        this.count(report, 'roles');
      })
    ];
    for (const chunk of chunks(work, READ_CONCURRENCY)) {
      if (this.now() >= deadline) break;
      await Promise.all(chunk.map((step) => step()));
      report.timeDependent += chunk.length;
    }
  }

  // ---------------------------------------------------------- full read

  /**
   * Goes on with the full read at `height` (the feed's, when it trails the
   * run's). A wave's roles, polls and wave REP and a decision's
   * leaderboard, which no event reads, are read at `childrenAt` (the
   * run's): read lower, they would take back what the feed's reads at the
   * run's height wrote, until their next change.
   */
  private async continueFull(
    initial: WavesChainIndexState,
    height: number,
    deadline: number,
    report: WavesChainIndexReport,
    childrenAt: number = height
  ): Promise<WavesChainIndexState> {
    let state = initial;
    // One step a run at least (a page, or a few waves or entries), however
    // long the feed took to reach the height, so a full read always ends
    // while the feed keeps up.
    let first = true;
    while (state.fullPhase && (first || this.now() < deadline)) {
      first = false;
      const stamp = { height, generation: state.generation };
      const children = { height: childrenAt, generation: state.generation };
      switch (state.fullPhase as FullPhase) {
        case 'groups':
          state = await this.fullGroups(state, stamp, deadline, report);
          break;
        case 'waves':
          state = await this.fullWaves(
            state,
            stamp,
            children,
            deadline,
            report
          );
          break;
        case 'decisions':
          state = await this.fullDecisions(
            state,
            stamp,
            children,
            deadline,
            report
          );
          break;
        case 'sweep':
          report.full.swept = await this.db.sweep(state.generation);
          report.full.completed = true;
          logger.info(
            `[FULL READ ${state.generation} DONE] removed ${JSON.stringify(report.full.swept)}`
          );
          state = await this.save({
            ...state,
            fullPhase: null,
            fullAfter: null,
            lastFullAt: this.now()
          });
          break;
        default:
          // A phase this version doesn't know: start again, next run.
          return this.startFull(state, height, false, report);
      }
    }
    return state;
  }

  private nextPhase(state: WavesChainIndexState): WavesChainIndexState {
    const index = FULL_PHASES.indexOf(state.fullPhase as FullPhase);
    return {
      ...state,
      fullPhase: FULL_PHASES[index + 1] ?? null,
      fullAfter: null
    };
  }

  private async fullGroups(
    initial: WavesChainIndexState,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    let after = state.fullAfter;
    for (;;) {
      const page = await this.api.listGroups(after, stamp.height);
      await this.db.upsert('groups', page.items.map(groupRow), stamp);
      report.full.items += page.items.length;
      if (!page.next) return this.save(this.nextPhase(state));
      if (page.next === after) throw repeatedCursor('/v1/groups', after);
      after = page.next;
      state = await this.save({ ...state, fullAfter: after });
      if (this.now() >= deadline) return state;
    }
  }

  private async fullWaves(
    initial: WavesChainIndexState,
    stamp: RowStamp,
    children: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    let after = state.fullAfter;
    for (;;) {
      const page = await this.api.listWaves(after, stamp.height);
      const waves = page.items.filter((wave) => idOf(wave, 'waveId'));
      for (const chunk of chunks(waves, READ_CONCURRENCY)) {
        await this.db.upsert('waves', chunk.map(waveRow), stamp);
        await Promise.all(
          chunk.map(async (wave) => {
            const waveId = idOf(wave, 'waveId') as string;
            await this.replaceRoles(waveId, children);
            await this.replaceWaveRep(waveId, children);
            await this.replacePolls(waveId, children);
          })
        );
        report.full.items += chunk.length;
        state = await this.save({
          ...state,
          fullAfter: idOf(chunk[chunk.length - 1], 'waveId')
        });
        if (this.now() >= deadline) return state;
      }
      if (!page.next) return this.save(this.nextPhase(state));
      if (page.next === after) throw repeatedCursor('/v1/waves', after);
      after = page.next;
    }
  }

  private async fullDecisions(
    initial: WavesChainIndexState,
    stamp: RowStamp,
    children: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    const cursor = splitCursor(state.fullAfter);
    if (cursor.decisionId && cursor.inProgress) {
      // A decision the last run stopped in: its entries from the cursor.
      const done = await this.fullEntries(
        state,
        cursor.decisionId,
        cursor.entryAfter,
        stamp,
        deadline,
        report
      );
      state = done.state;
      if (!done.finished) return state;
      state = await this.save({ ...state, fullAfter: cursor.decisionId });
      if (this.now() >= deadline) return state;
    }
    let after = splitCursor(state.fullAfter).decisionId;
    for (;;) {
      const page = await this.api.listDecisions(after, stamp.height);
      for (const decision of page.items) {
        const decisionId = idOf(decision, 'decisionId');
        if (!decisionId) continue;
        state = await this.fullDecisionHead(
          state,
          decision,
          stamp,
          children,
          report
        );
        const done = await this.fullEntries(
          state,
          decisionId,
          null,
          stamp,
          deadline,
          report
        );
        state = done.state;
        if (!done.finished) return state;
        state = await this.save({ ...state, fullAfter: decisionId });
        if (this.now() >= deadline) return state;
      }
      if (!page.next) return this.save(this.nextPhase(state));
      if (page.next === after) throw repeatedCursor('/v1/decisions', after);
      after = page.next;
    }
  }

  /** A decision, its results and its board; the cursor says so. */
  private async fullDecisionHead(
    state: WavesChainIndexState,
    decision: ChainObject,
    stamp: RowStamp,
    children: RowStamp,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    const decisionId = idOf(decision, 'decisionId') as string;
    await this.db.upsert('decisions', [decisionRow(decision)], stamp);
    const results =
      (await this.api.decisionResults(decisionId, stamp.height)) ?? [];
    await this.db.upsert(
      'results',
      results.map((result) => resultRow(decisionId, result)),
      stamp
    );
    await this.refreshLeaderboard(
      decisionId,
      decision.status === 'published',
      children,
      report
    );
    report.full.items++;
    return this.save({ ...state, fullAfter: `${decisionId}:` });
  }

  /**
   * A decision's entries after `entryAfter`, a page at a time, and each
   * entry's votes. Stops between groups of entries at the deadline, with
   * the cursor at the last entry done.
   */
  private async fullEntries(
    initial: WavesChainIndexState,
    decisionId: string,
    entryAfter: string | null,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<{ state: WavesChainIndexState; finished: boolean }> {
    let state = initial;
    let after = entryAfter;
    for (;;) {
      const page = await this.api.decisionEntries(
        decisionId,
        after,
        stamp.height
      );
      const entries = page.items.filter((entry) => idOf(entry, 'entryId'));
      for (const chunk of chunks(entries, READ_CONCURRENCY)) {
        await this.db.upsert('entries', chunk.map(entryRow), stamp);
        await Promise.all(
          chunk.map(async (entry) => {
            const votes = await this.api.entryVotes(
              idOf(entry, 'entryId') as string,
              stamp.height
            );
            await this.db.upsert('votes', (votes ?? []).map(voteRow), stamp);
          })
        );
        report.full.items += chunk.length;
        const last = idOf(chunk[chunk.length - 1], 'entryId');
        state = await this.save({
          ...state,
          fullAfter: `${decisionId}:${last}`
        });
        if (this.now() >= deadline) return { state, finished: false };
      }
      if (!page.next) return { state, finished: true };
      if (page.next === after) {
        throw repeatedCursor(`/v1/decisions/${decisionId}/entries`, after);
      }
      after = page.next;
    }
  }
}

export const wavesChainIndex = new WavesChainIndex(
  new GatewayWavesChainApi(),
  wavesChainIndexDb
);
