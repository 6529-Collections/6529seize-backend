import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { ChainFeedPage } from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import { Time } from '@/time';
import {
  ChainObject,
  GatewayWavesChainApi,
  WavesChainApi
} from './waves-chain-index.api';
import {
  EMPTY_INDEX_STATE,
  IndexTableName,
  RowStamp,
  WavesChainIndexDb,
  wavesChainIndexDb,
  WavesChainIndexState
} from './waves-chain-index.db';
import {
  emptyFeedEffects,
  FeedEffects,
  feedEffects,
  splitFeedEffects,
  WAVES_FEED_FAMILIES
} from './waves-chain-index.feed';
import { ChainFeedBlock } from '@/chain-gateway/chain-gateway.types';
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
 * cursor. A new network id (a relaunched chain) empties the index first.
 * Nothing runs before the chain's waves import completes.
 */

export const FULL_READ_EVERY_MS = Time.hours(24).toMillis();

export const FULL_PHASES = ['groups', 'waves', 'decisions', 'sweep'] as const;
export type FullPhase = (typeof FULL_PHASES)[number];

/** Feed records are applied in batches of about this many reads. */
const BATCH_READS = 100;
/** Reads in flight at once. */
const READ_CONCURRENCY = 8;
/** A feed read answered `gone` is asked again this many times first. */
const GONE_RETRIES = 2;

export interface WavesChainIndexReport {
  mode: 'idle' | 'skipped' | 'indexed';
  skipped?: 'import_not_complete' | 'gateway_behind';
  height: number | null;
  feedFrom: number | null;
  feedNext: number | null;
  feedBatches: number;
  reread: Record<string, number>;
  votes: number;
  /** Leaderboard rows written or deleted (only the ones that moved). */
  leaderboardRows: number;
  timeDependent: number;
  full: {
    generation: number;
    phase: string | null;
    started: boolean;
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
function splitCursor(after: string | null): {
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
    private readonly fullEveryMs: number = FULL_READ_EVERY_MS
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
      leaderboardRows: 0,
      timeDependent: 0,
      full: {
        generation: state.generation,
        phase: state.fullPhase,
        started: false,
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
    report.mode = 'indexed';
    state = await this.save({
      ...state,
      readHeight: height,
      network: head.network ?? state.network
    });
    try {
      const fullDue =
        state.lastFullAt !== null &&
        this.now() - state.lastFullAt > this.fullEveryMs;
      if (state.feedNext === null || (!state.fullPhase && fullDue)) {
        state = await this.startFull(state, height, false, report);
      }
      state = await this.followFeed(state, height, deadline, report);
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
        state = await this.continueFull(state, height, deadline, report);
      }
      if (state.lastError !== null) {
        state = await this.save({ ...state, lastError: null });
      }
    } catch (error) {
      if (error instanceof ChainGatewayError && error.code === 'gone') {
        // The feed no longer goes back to the cursor: what changed since is
        // only in the chain's state now. Read it all again from H.
        logger.warn(
          `[FEED GONE FROM ${state.feedNext}] full read from ${height}`
        );
        report.restartedFull = 'feed_gone';
        await this.startFull(state, height, true, report);
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
    return this.save({
      ...state,
      generation: state.generation + 1,
      fullPhase: FULL_PHASES[0],
      fullAfter: null,
      fullFromHeight: height,
      feedNext:
        feedGone || state.feedNext === null ? height + 1 : state.feedNext,
      // Parts done of a block before the new cursor count for nothing past it.
      feedPart: feedGone || state.feedNext === null ? 0 : state.feedPart
    });
  }

  private count(report: WavesChainIndexReport, table: string, n = 1) {
    report.reread[table] = (report.reread[table] ?? 0) + n;
  }

  // ---------------------------------------------------------------- feed

  private async readFeed(from: number): Promise<ChainFeedPage> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api.feed(from, WAVES_FEED_FAMILIES);
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
   * BATCH_READS reads, saving the cursor after each, until the deadline. A
   * block with more than that is a batch of its own, applied in parts with
   * the deadline checked between them; a run that stops inside it saves
   * the parts done (feedPart), and the next goes on from there.
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
      const flush = async (to: number) => {
        await this.applyEffects(batch, stamp, report);
        batch = emptyFeedEffects();
        next = to;
        state = await this.save({ ...state, feedNext: next, feedPart: 0 });
      };
      for (const block of blocks) {
        const own = feedEffects({ blocks: [block] });
        if (readsOf(own) > BATCH_READS) {
          // What came before it first; a run resuming it starts at it.
          if (next < block.height) await flush(block.height);
          const done = await this.applyBlockInParts(
            state,
            block,
            own,
            stamp,
            deadline,
            report
          );
          state = done.state;
          next = state.feedNext as number;
          if (!done.finished || this.now() >= deadline) break feed;
          continue;
        }
        feedEffects({ blocks: [block] }, batch);
        if (readsOf(batch) >= BATCH_READS && block.height + 1 < end) {
          await flush(block.height + 1);
          if (this.now() >= deadline) break feed;
        }
      }
      await flush(end);
    }
    return state;
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
    report: WavesChainIndexReport
  ): Promise<{ state: WavesChainIndexState; finished: boolean }> {
    let state = initial;
    const parts = splitFeedEffects(effects, BATCH_READS);
    const from =
      state.feedNext === block.height
        ? Math.min(state.feedPart, parts.length)
        : 0;
    for (let k = from; k < parts.length; k++) {
      await this.applyEffects(parts[k], stamp, report);
      if (k + 1 < parts.length) {
        state = await this.save({
          ...state,
          feedNext: block.height,
          feedPart: k + 1
        });
        if (this.now() >= deadline) return { state, finished: false };
      }
    }
    state = await this.save({
      ...state,
      feedNext: block.height + 1,
      feedPart: 0
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

  private async applyEffects(
    effects: FeedEffects,
    stamp: RowStamp,
    report: WavesChainIndexReport
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
    await eachLimit(
      Array.from(effects.voteEntries),
      READ_CONCURRENCY,
      async (entryId) => {
        const votes = await this.api.entryVotes(entryId, at);
        await this.db.replaceChildren(
          'votes',
          'entry_id',
          entryId,
          (votes ?? []).map(voteRow),
          stamp
        );
        this.count(report, 'votes');
      }
    );
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

  private async continueFull(
    initial: WavesChainIndexState,
    height: number,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    // One step a run at least (a page, or a few waves or entries), however
    // long the feed took, so a full read always ends.
    let first = true;
    while (state.fullPhase && (first || this.now() < deadline)) {
      first = false;
      const stamp = { height, generation: state.generation };
      switch (state.fullPhase as FullPhase) {
        case 'groups':
          state = await this.fullGroups(state, stamp, deadline, report);
          break;
        case 'waves':
          state = await this.fullWaves(state, stamp, deadline, report);
          break;
        case 'decisions':
          state = await this.fullDecisions(state, stamp, deadline, report);
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
      if (!page.next || page.next === after) {
        return this.save(this.nextPhase(state));
      }
      after = page.next;
      state = await this.save({ ...state, fullAfter: after });
      if (this.now() >= deadline) return state;
    }
  }

  private async fullWaves(
    initial: WavesChainIndexState,
    stamp: RowStamp,
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
            await this.replaceRoles(waveId, stamp);
            await this.replaceWaveRep(waveId, stamp);
            await this.replacePolls(waveId, stamp);
          })
        );
        report.full.items += chunk.length;
        state = await this.save({
          ...state,
          fullAfter: idOf(chunk[chunk.length - 1], 'waveId')
        });
        if (this.now() >= deadline) return state;
      }
      if (!page.next || page.next === after) {
        return this.save(this.nextPhase(state));
      }
      after = page.next;
    }
  }

  private async fullDecisions(
    initial: WavesChainIndexState,
    stamp: RowStamp,
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
        state = await this.fullDecisionHead(state, decision, stamp, report);
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
      if (!page.next || page.next === after) {
        return this.save(this.nextPhase(state));
      }
      after = page.next;
    }
  }

  /** A decision, its results and its board; the cursor says so. */
  private async fullDecisionHead(
    state: WavesChainIndexState,
    decision: ChainObject,
    stamp: RowStamp,
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
      stamp,
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
      if (!page.next || page.next === after) {
        return { state, finished: true };
      }
      after = page.next;
    }
  }
}

export const wavesChainIndex = new WavesChainIndex(
  new GatewayWavesChainApi(),
  wavesChainIndexDb
);
