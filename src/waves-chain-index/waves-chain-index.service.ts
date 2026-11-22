import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import { Time } from '@/time';
import {
  ChainObject,
  GatewayWavesChainApi,
  WavesChainApi
} from './waves-chain-index.api';
import {
  IndexTableName,
  RowStamp,
  WavesChainIndexDb,
  wavesChainIndexDb,
  WavesChainIndexState
} from './waves-chain-index.db';
import {
  FeedEffects,
  feedEffects,
  WAVES_FEED_FAMILIES
} from './waves-chain-index.feed';
import {
  decisionRow,
  entryRow,
  groupRow,
  IndexRow,
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
 * Each run pins every read to one finalized height H:
 * 1. the change feed from the cursor up to H: every object a record touched
 *    is read again (votes are taken from the record itself);
 * 2. the objects whose answer moves with time (live decisions and their
 *    leaderboards, open polls, role grants past their expiry);
 * 3. a full read in progress continues: groups, then waves (roles, polls,
 *    wave REP), then decisions (entries, results, leaderboard, each entry's
 *    votes), then rows the full read did not see are removed.
 * The first full read starts the feed at its first height + 1, so the feed
 * replays whatever changed while the full read went on. A full read runs
 * again every day, and at once when the gateway no longer holds the feed
 * from the cursor. Nothing runs before the chain's waves import completes.
 */

export const FULL_READ_EVERY_MS = Time.hours(24).toMillis();

export const FULL_PHASES = ['groups', 'waves', 'decisions', 'sweep'] as const;
export type FullPhase = (typeof FULL_PHASES)[number];

export interface WavesChainIndexReport {
  mode: 'idle' | 'skipped' | 'indexed';
  skipped?: 'import_not_complete' | 'gateway_behind';
  height: number | null;
  feedFrom: number | null;
  feedNext: number | null;
  feedPages: number;
  reread: Record<string, number>;
  votes: number;
  timeDependent: number;
  full: {
    generation: number;
    phase: string | null;
    started: boolean;
    items: number;
    completed: boolean;
    swept: Record<string, number> | null;
  };
  restartedFull: 'feed_gone' | null;
}

const ZERO = (): Record<string, number> => ({});

function idOf(object: ChainObject, field: string): string | null {
  const value = object[field];
  return typeof value === 'string' && value ? value.toLowerCase() : null;
}

/** A decision in progress in the full read: `decisionId:entryId`. */
function splitCursor(after: string | null): {
  decisionId: string | null;
  entryAfter: string | null;
} {
  if (!after) return { decisionId: null, entryAfter: null };
  const [decisionId, entryAfter] = after.split(':');
  return { decisionId, entryAfter: entryAfter ?? null };
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
      feedPages: 0,
      reread: ZERO(),
      votes: 0,
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
    const imported = await this.api.importState();
    if (!imported?.completed) {
      report.mode = 'skipped';
      report.skipped = 'import_not_complete';
      return report;
    }
    const height = await this.api.finalizedHeight();
    report.height = height;
    if (state.feedNext !== null && height < state.feedNext - 1) {
      // The gateway answered from a node behind the index.
      report.mode = 'skipped';
      report.skipped = 'gateway_behind';
      return report;
    }
    report.mode = 'indexed';
    try {
      const fullDue =
        state.lastFullAt !== null &&
        this.now() - state.lastFullAt > this.fullEveryMs;
      if (state.feedNext === null || (!state.fullPhase && fullDue)) {
        state = await this.startFull(state, height, false, report);
      }
      state = await this.followFeed(state, height, deadline, report);
      await this.refreshTimeDependent(state, height, report);
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
        feedGone || state.feedNext === null ? height + 1 : state.feedNext
    });
  }

  // ---------------------------------------------------------------- feed

  private async followFeed(
    initial: WavesChainIndexState,
    height: number,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    let next = state.feedNext as number;
    while (next <= height && this.now() < deadline) {
      const page = await this.api.feed(next, WAVES_FEED_FAMILIES);
      // Only what the run's reads can see: heights up to H.
      const blocks = page.blocks.filter(
        (block) => block.height >= next && block.height <= height
      );
      const effects = feedEffects({ blocks });
      await this.applyEffects(
        effects,
        { height, generation: state.generation },
        report
      );
      report.feedPages++;
      const pageNext = Number.isFinite(Number(page.next))
        ? Number(page.next)
        : Number(page.through) + 1;
      const advanced = Math.min(pageNext, height + 1);
      if (!(advanced > next)) break;
      next = advanced;
      state = await this.save({ ...state, feedNext: next });
    }
    return state;
  }

  private count(report: WavesChainIndexReport, table: string, n = 1) {
    report.reread[table] = (report.reread[table] ?? 0) + n;
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
    const at = stamp.height;
    for (const id of Array.from(effects.groups)) {
      await this.refreshOne(
        'groups',
        await this.api.group(id, at),
        groupRow,
        { group_id: id },
        stamp,
        report
      );
    }
    for (const id of Array.from(effects.waves)) {
      await this.refreshOne(
        'waves',
        await this.api.wave(id, at),
        waveRow,
        { wave_id: id },
        stamp,
        report
      );
    }
    for (const waveId of Array.from(effects.roleWaves)) {
      await this.replaceRoles(waveId, stamp);
      this.count(report, 'roles');
    }
    for (const waveId of Array.from(effects.repWaves)) {
      await this.replaceWaveRep(waveId, stamp);
      this.count(report, 'waveRep');
    }
    for (const id of Array.from(effects.polls)) {
      await this.refreshOne(
        'polls',
        await this.api.poll(id, at),
        pollRow,
        { poll_id: id },
        stamp,
        report
      );
    }
    const leaderboards = new Set(effects.leaderboards);
    for (const id of Array.from(effects.decisions)) {
      await this.refreshOne(
        'decisions',
        await this.api.decision(id, at),
        decisionRow,
        { decision_id: id },
        stamp,
        report
      );
    }
    for (const id of Array.from(effects.entries)) {
      const entry = await this.refreshOne(
        'entries',
        await this.api.entry(id, at),
        entryRow,
        { entry_id: id },
        stamp,
        report
      );
      const decisionId = entry ? idOf(entry, 'decisionId') : null;
      if (decisionId) leaderboards.add(decisionId);
    }
    for (const { decisionId, resultTime } of Array.from(
      effects.results.values()
    )) {
      await this.refreshOne(
        'results',
        await this.api.result(decisionId, resultTime, at),
        (result) => resultRow(decisionId, result),
        { decision_id: decisionId, result_time: resultTime },
        stamp,
        report
      );
    }
    const votes = Array.from(effects.votes.values());
    if (votes.length) {
      await this.db.applyVotes(votes, stamp);
      report.votes += votes.length;
    }
    for (const decisionId of Array.from(leaderboards)) {
      await this.refreshLeaderboard(decisionId, stamp);
      this.count(report, 'leaderboards');
    }
  }

  private async refreshLeaderboard(decisionId: string, stamp: RowStamp) {
    const leaderboard = await this.api.decisionLeaderboard(
      decisionId,
      stamp.height
    );
    if (leaderboard) {
      await this.db.upsert(
        'leaderboards',
        [leaderboardRow(decisionId, leaderboard)],
        stamp
      );
    } else {
      await this.db.remove('leaderboards', [{ decision_id: decisionId }]);
    }
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

  // ---------------------------------------------------------- time moves

  private async refreshTimeDependent(
    state: WavesChainIndexState,
    height: number,
    report: WavesChainIndexReport
  ): Promise<void> {
    const stamp = { height, generation: state.generation };
    const { decisionIds, pollIds, roleWaveIds } = await this.db.timeDependent(
      this.now()
    );
    for (const id of decisionIds) {
      const decision = await this.refreshOne(
        'decisions',
        await this.api.decision(id, height),
        decisionRow,
        { decision_id: id },
        stamp,
        report
      );
      // A counted decision's scores move with its block time.
      if (decision?.counted === true) {
        await this.refreshLeaderboard(id, stamp);
        this.count(report, 'leaderboards');
      }
    }
    for (const id of pollIds) {
      await this.refreshOne(
        'polls',
        await this.api.poll(id, height),
        pollRow,
        { poll_id: id },
        stamp,
        report
      );
    }
    for (const waveId of roleWaveIds) {
      await this.replaceRoles(waveId, stamp);
      this.count(report, 'roles');
    }
    report.timeDependent =
      decisionIds.length + pollIds.length + roleWaveIds.length;
  }

  // ---------------------------------------------------------- full read

  private async continueFull(
    initial: WavesChainIndexState,
    height: number,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let state = initial;
    const stamp = { height, generation: state.generation };
    // At least one step a run, however long the feed took.
    let first = true;
    while (state.fullPhase && (first || this.now() < deadline)) {
      first = false;
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
          // A phase this version doesn't know: start again.
          state = await this.startFull(state, height, false, report);
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
    state: WavesChainIndexState,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
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
    state: WavesChainIndexState,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    let after = state.fullAfter;
    for (;;) {
      const page = await this.api.listWaves(after, stamp.height);
      for (const wave of page.items) {
        const waveId = idOf(wave, 'waveId');
        if (!waveId) continue;
        await this.db.upsert('waves', [waveRow(wave)], stamp);
        await this.replaceRoles(waveId, stamp);
        await this.replaceWaveRep(waveId, stamp);
        const polls = (await this.api.wavePolls(waveId, stamp.height)) ?? [];
        await this.db.replaceChildren(
          'polls',
          'wave_id',
          waveId,
          polls.map(pollRow),
          stamp
        );
        report.full.items++;
        state = await this.save({ ...state, fullAfter: waveId });
        if (this.now() >= deadline) return state;
      }
      if (!page.next || page.next === after) {
        return this.save(this.nextPhase(state));
      }
      after = page.next;
    }
  }

  private async fullDecisions(
    state: WavesChainIndexState,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<WavesChainIndexState> {
    const cursor = splitCursor(state.fullAfter);
    if (cursor.decisionId && cursor.entryAfter !== null) {
      // A decision the last run stopped in: finish it first.
      const decision = await this.api.decision(cursor.decisionId, stamp.height);
      if (decision) {
        const done = await this.fullDecision(
          state,
          decision,
          cursor.entryAfter,
          stamp,
          deadline,
          report
        );
        state = done.state;
        if (!done.finished) return state;
      } else {
        await this.db.remove('decisions', [{ decision_id: cursor.decisionId }]);
      }
      state = await this.save({ ...state, fullAfter: cursor.decisionId });
      if (this.now() >= deadline) return state;
    }
    let after = splitCursor(state.fullAfter).decisionId;
    for (;;) {
      const page = await this.api.listDecisions(after, stamp.height);
      for (const decision of page.items) {
        const decisionId = idOf(decision, 'decisionId');
        if (!decisionId) continue;
        const done = await this.fullDecision(
          state,
          decision,
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

  /**
   * One decision whole: the decision, its entries, results and leaderboard,
   * then each entry's votes from `entryAfter`. Stops between entries at the
   * deadline, saving `decisionId:entryId`.
   */
  private async fullDecision(
    initial: WavesChainIndexState,
    decision: ChainObject,
    entryAfter: string | null,
    stamp: RowStamp,
    deadline: number,
    report: WavesChainIndexReport
  ): Promise<{ state: WavesChainIndexState; finished: boolean }> {
    let state = initial;
    const decisionId = idOf(decision, 'decisionId') as string;
    const at = stamp.height;
    await this.db.upsert('decisions', [decisionRow(decision)], stamp);
    const entries = (await this.api.decisionEntries(decisionId, at)) ?? [];
    await this.db.replaceChildren(
      'entries',
      'decision_id',
      decisionId,
      entries.map(entryRow),
      stamp
    );
    const results = (await this.api.decisionResults(decisionId, at)) ?? [];
    await this.db.replaceChildren(
      'results',
      'decision_id',
      decisionId,
      results.map((result) => resultRow(decisionId, result)),
      stamp
    );
    await this.refreshLeaderboard(decisionId, stamp);
    report.full.items++;
    const entryIds = entries
      .map((entry) => idOf(entry, 'entryId'))
      .filter((id): id is string => !!id)
      .sort();
    for (const entryId of entryIds) {
      if (entryAfter !== null && entryId <= entryAfter) continue;
      const votes = (await this.api.entryVotes(entryId, at)) ?? [];
      await this.db.replaceChildren(
        'votes',
        'entry_id',
        entryId,
        votes.map(voteRow),
        stamp
      );
      if (this.now() >= deadline) {
        state = await this.save({
          ...state,
          fullAfter: `${decisionId}:${entryId}`
        });
        return { state, finished: entryId === entryIds[entryIds.length - 1] };
      }
    }
    return { state, finished: true };
  }
}

export const wavesChainIndex = new WavesChainIndex(
  new GatewayWavesChainApi(),
  wavesChainIndexDb
);
