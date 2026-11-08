import { recordNativeCompetitionRun } from './native-competition-metrics';
import {
  CompetitionCreditService,
  competitionCreditService
} from './competition-credit.service';
import { Competition, CompetitionPause } from './competition.types';
import {
  CompetitionLifecycle,
  CompetitionCapability,
  CompetitionType
} from '@/entities/ICompetition';
import {
  competitionExecutionRouter,
  CompetitionExecutionRouter
} from './competition-execution.router';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { reportLoopHealth } from '@/loop-health';
import { WaveCreditScope } from '@/entities/IWave';
import { readSequentially } from '@/competitions/competition-read-sequence';
import { computeCompetitionPhase } from './competition-phase';
import {
  NativeCompetitionRuntimeRepository,
  nativeCompetitionRuntimeRepository,
  NativeDecisionWinner,
  NativeHistoryRow,
  NativeLeaderboardRow,
  NativeRuntimeEntry
} from './native-competition-runtime.repository';
import {
  NativeAward,
  NativeOutcome,
  NativeVotePoint,
  nativeAwardsForRank,
  nativeThresholdSince,
  nativeWinnerCount,
  nextNativeDecision,
  reducedNativeVotes,
  flooredWeightedNativeVote
} from './native-competition-runtime.helpers';

type RuntimeState = {
  entries: NativeRuntimeEntry[];
  history: NativeHistoryRow[];
  pauses: CompetitionPause[];
};

/** Outcome of refreshing a leaderboard without holding the competition row. */
export type OffLockLeaderboardRefresh = 'written' | 'changed' | 'inapplicable';

/** Test seam: runs between the off-lock computation and the locked write. */
export type OffLockRefreshHooks = {
  readonly afterCompute?: () => Promise<void>;
};

function isTimeLocked(competition: Competition): boolean {
  return (competition.decisions.time_lock_ms ?? 0) > 0;
}

type ScoredEntry = {
  entry: NativeRuntimeEntry;
  rating: number;
  lastChangedAt: number;
  lastIncreasedAt: number | null;
  overThresholdSince: number | null;
};

function isPaused(pauses: readonly CompetitionPause[], time: number): boolean {
  return pauses.some(
    (pause) =>
      time >= pause.start_time &&
      (pause.end_time === null || time <= pause.end_time)
  );
}

function aggregatePoints(
  history: readonly NativeHistoryRow[],
  entryId: string
): NativeVotePoint[] {
  return history
    .filter((row) => row.entry_id === entryId && row.kind !== 'VOTER')
    .map((row) => ({
      timestamp: row.occurred_at,
      vote: row.aggregate_value,
      sequence: row.order_sequence ?? row.sequence
    }));
}

function voterPoints(
  history: readonly NativeHistoryRow[]
): Map<string, Map<string, NativeVotePoint[]>> {
  const result = new Map<string, Map<string, NativeVotePoint[]>>();
  for (const row of history) {
    if (row.kind === 'AGGREGATE') continue;
    let entry = result.get(row.entry_id);
    if (!entry) {
      entry = new Map();
      result.set(row.entry_id, entry);
    }
    let points = entry.get(row.voter_profile_id);
    if (!points) {
      points = [];
      entry.set(row.voter_profile_id, points);
    }
    points.push({
      timestamp: row.occurred_at,
      vote: row.value,
      sequence: row.order_sequence ?? row.sequence
    });
  }
  return result;
}

export class NativeCompetitionRuntimeService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly repository: NativeCompetitionRuntimeRepository,
    private readonly credits: Pick<
      CompetitionCreditService,
      'getBudget' | 'getWaveBudgets' | 'getDropBudgets'
    >,
    private readonly executionRouter: CompetitionExecutionRouter
  ) {}

  /**
   * `activeVotes` are the voter's active votes when the caller already read
   * them in this transaction (exactly what getVoterActiveVotes returns).
   */
  public async reconcileVoterCredit(
    params: {
      competitionId: string;
      voterProfileId: string;
      availableCredit: number;
      creditScope: string;
      occurredAt: number;
    },
    ctx: RequestContext,
    activeVotes?: readonly { entryId: string; value: number }[]
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error(
        'Credit reconciliation requires the competition transaction lock'
      );
    const current =
      activeVotes ??
      (await this.repository.getVoterActiveVotes(
        params.competitionId,
        params.voterProfileId,
        ctx
      ));
    const reduced = reducedNativeVotes(
      current,
      params.availableCredit,
      params.creditScope
    );
    const previousByEntry = new Map(
      current.map((vote) => [vote.entryId, vote.value])
    );
    for (const vote of reduced) {
      const previousVote = previousByEntry.get(vote.entryId) ?? 0;
      if (vote.value === previousVote) continue;
      const mutation = {
        competitionId: params.competitionId,
        entryId: vote.entryId,
        voterProfileId: params.voterProfileId,
        value: vote.value,
        occurredAt: params.occurredAt
      };
      await this.repository.replaceVoteForReconciliation(mutation, ctx);
      await this.repository.recordVoteChange(
        { ...mutation, previousVote, reason: 'CREDIT_OVERSPENT' },
        ctx
      );
    }
  }

  private async reconcileCompetitionCredit(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const voters = await this.repository.listActiveVoters(competition.id, ctx);
    const scope = competition.voting.credit_scope;
    const waveBudgets =
      scope === WaveCreditScope.WAVE
        ? await this.credits.getWaveBudgets(competition, voters, ctx)
        : null;
    // DROP scope checks every voter's votes: read the budgets and the votes
    // in a few paged statements instead of ~4 statements per voter. Same
    // transaction and lock; reconciliation reads nothing it writes, so the
    // writes (and their order) are unchanged.
    const dropBudgets =
      scope === WaveCreditScope.DROP
        ? await this.credits.getDropBudgets(competition, voters, ctx)
        : null;
    const dropVotes =
      scope === WaveCreditScope.DROP
        ? await this.repository.getVotersActiveVotes(
            competition.id,
            voters,
            ctx
          )
        : null;
    await readSequentially(voters, async (voterProfileId) => {
      const budget =
        waveBudgets?.get(voterProfileId) ??
        dropBudgets?.get(voterProfileId) ??
        (await this.credits.getBudget(
          competition,
          voterProfileId,
          undefined,
          ctx
        ));
      // WAVE spending is the sum of absolute active votes. If it fits, no
      // individual vote needs reducing. DROP budgets must still check each entry.
      if (
        waveBudgets &&
        budget.spent !== null &&
        budget.spent <= budget.available
      )
        return;
      await this.reconcileVoterCredit(
        {
          competitionId: competition.id,
          voterProfileId,
          availableCredit: budget.available,
          creditScope: competition.voting.credit_scope,
          occurredAt: now
        },
        ctx,
        dropVotes?.get(voterProfileId)
      );
    });
  }

  /** The API may refresh its just-written leaderboard in the existing transaction.
   * Discovery/decisions remain separately gated by native execution. */
  public async refreshCompetition(
    competitionId: string,
    now: number,
    ctx: RequestContext = {}
  ): Promise<void> {
    if (!ctx.connection)
      return this.repository.executeNativeQueriesInTransaction((connection) =>
        this.refreshCompetition(competitionId, now, { ...ctx, connection })
      );
    const competition = await this.repository.lockCompetition(
      competitionId,
      ctx
    );
    if (
      !competition ||
      competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
      !this.executionRouter.isNativeExecutionAllowed(competition)
    )
      return;
    await this.emitScheduledTransitions(competition, now, ctx);
    await this.reconcileCompetitionCredit(competition, now, ctx);
    await this.refreshLeaderboardAfterCreditReconciliation(
      competition,
      now,
      ctx
    );
  }

  /** Bulk TDH revocation has already reconciled every over-limit voter under
   * this competition's transaction lock, including their notifications. */
  public async refreshLeaderboardAfterCreditReconciliation(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error(
        'Leaderboard refresh requires the competition transaction lock'
      );
    const state = await this.loadState(competition.id, ctx);
    await this.refreshLeaderboard(competition, state, now, ctx);
  }

  /** A confirmed NFT transfer resolves CURATION entries through native winner
   * snapshots. The transfer key makes retries harmless; different transfers in
   * the same millisecond may append to the same historical decision identity. */
  public async resolveCurationEntries(
    competitionId: string,
    dropIds: readonly string[],
    decisionTime: number,
    transferKey: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const competition = await this.repository.lockCompetition(
      competitionId,
      ctx
    );
    if (
      !competition ||
      !competition.capabilities.includes(CompetitionCapability.CURATION)
    )
      return false;
    if (
      competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
      !this.executionRouter.isNativeExecutionAllowed(competition)
    )
      return false;
    const state = await this.loadState(competitionId, ctx);
    const selected = this.scores(competition, state, decisionTime).filter(
      (score) => dropIds.includes(score.entry.drop_id)
    );
    if (!selected.length) return true;
    await this.repository.saveDecision(
      {
        competition,
        scheduledAt: decisionTime,
        now: Date.now(),
        winners: selected.map((score) => this.winner(score, 1)),
        awards: new Map(),
        voterPoints: voterPoints(state.history),
        finalVote: (points) =>
          flooredWeightedNativeVote(
            points,
            decisionTime,
            competition.decisions.time_lock_ms ?? 0
          ),
        skipped: false,
        decisionKey: transferKey
      },
      ctx
    );
    const won = new Set(selected.map((score) => score.entry.id));
    state.entries = state.entries.filter((entry) => !won.has(entry.id));
    await this.refreshLeaderboard(competition, state, Date.now(), ctx);
    return true;
  }

  public async refreshNativeLeaderboards(
    timer: Timer,
    now = Date.now()
  ): Promise<void> {
    await this.forEachNativeCompetition(
      timer,
      'leaderboard',
      (competitionId, ctx) =>
        this.refreshLeaderboardForSnapshot(competitionId, now, ctx)
    );
  }

  /**
   * The snapshotter's refresh. Transitions and credit reconciliation stay
   * under the competition lock. A time-locked competition's leaderboard is
   * then computed off the lock (refreshLeaderboardOffLock); if its inputs
   * changed meanwhile, the locked refresh runs as before, so the snapshot is
   * never older than one snapshotter interval.
   */
  public async refreshLeaderboardForSnapshot(
    competitionId: string,
    now: number,
    ctx: RequestContext = {},
    hooks: OffLockRefreshHooks = {}
  ): Promise<void> {
    if (ctx.connection) return this.refreshCompetition(competitionId, now, ctx);
    const startedAt = Date.now();
    const next = await this.repository.executeNativeQueriesInTransaction(
      async (connection): Promise<'skipped' | 'locked' | 'off_lock'> => {
        const lockedCtx = { ...ctx, connection };
        const competition = await this.repository.lockCompetition(
          competitionId,
          lockedCtx
        );
        if (
          !competition ||
          competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
          !this.executionRouter.isNativeExecutionAllowed(competition)
        )
          return 'skipped';
        await this.emitScheduledTransitions(competition, now, lockedCtx);
        await this.reconcileCompetitionCredit(competition, now, lockedCtx);
        if (isTimeLocked(competition)) return 'off_lock';
        await this.refreshLeaderboardAfterCreditReconciliation(
          competition,
          now,
          lockedCtx
        );
        return 'locked';
      }
    );
    let lockedMs = Date.now() - startedAt;
    if (next === 'skipped') return;
    if (next === 'locked') {
      recordNativeCompetitionRun({
        competitionId,
        operation: 'leaderboard',
        path: 'locked',
        lockedMs,
        computeMs: 0,
        durationMs: Date.now() - startedAt
      });
      return;
    }
    let computeMs = 0;
    const outcome = await this.refreshLeaderboardOffLock(
      competitionId,
      now,
      ctx,
      hooks,
      {
        operation: 'leaderboard',
        extraLockedMs: lockedMs,
        onMeasured: (measured) => {
          computeMs = measured.computeMs;
          lockedMs += measured.writeLockedMs;
        }
      }
    );
    if (outcome === 'changed') {
      const fallbackStartedAt = Date.now();
      await this.refreshCompetition(competitionId, now, ctx);
      lockedMs += Date.now() - fallbackStartedAt;
    }
    recordNativeCompetitionRun({
      competitionId,
      operation: 'leaderboard',
      path: outcome === 'changed' ? 'off_lock_fallback' : 'off_lock',
      lockedMs,
      computeMs,
      durationMs: Date.now() - startedAt
    });
  }

  /**
   * Refreshes a leaderboard while holding the competition row only to write
   * it. Entries, history and pauses are read in one consistent snapshot
   * without the lock and scored there; the write then takes the lock and
   * proceeds only if leaderboardInputsMark is unchanged since the snapshot.
   * Otherwise a vote, entry, pause or configuration change landed during the
   * computation and nothing is written ('changed'): no update is lost and no
   * stale leaderboard overwrites a newer one. Decisions never use this.
   */
  public async refreshLeaderboardOffLock(
    competitionId: string,
    now: number,
    ctx: RequestContext = {},
    hooks: OffLockRefreshHooks = {},
    report: {
      operation: 'leaderboard' | 'decisions';
      extraLockedMs?: number;
      /** Receives the computation and this refresh's own locked write. */
      onMeasured?: (measured: {
        computeMs: number;
        writeLockedMs: number;
      }) => void;
    } = { operation: 'leaderboard' }
  ): Promise<OffLockLeaderboardRefresh> {
    if (ctx.connection)
      throw new Error('An off-lock refresh cannot join a transaction');
    const computeStartedAt = Date.now();
    const computed = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const snapshotCtx = { ...ctx, connection };
        const competition = await this.repository.readCompetition(
          competitionId,
          snapshotCtx
        );
        if (
          !competition ||
          competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
          !this.executionRouter.isNativeExecutionAllowed(competition)
        )
          return null;
        const mark = await this.repository.leaderboardInputsMark(
          competitionId,
          snapshotCtx
        );
        const state = await this.loadState(competitionId, snapshotCtx);
        return {
          competition,
          mark,
          ...this.leaderboardRows(competition, state, now)
        };
      }
    );
    const computeMs = Date.now() - computeStartedAt;
    if (!computed) return 'inapplicable';
    await hooks.afterCompute?.();
    const writeStartedAt = Date.now();
    const outcome = await this.repository.executeNativeQueriesInTransaction(
      async (connection): Promise<OffLockLeaderboardRefresh> => {
        const lockedCtx = { ...ctx, connection };
        const competition = await this.repository.lockCompetition(
          competitionId,
          lockedCtx
        );
        if (
          !competition ||
          competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
          !this.executionRouter.isNativeExecutionAllowed(competition)
        )
          return 'inapplicable';
        const mark = await this.repository.leaderboardInputsMark(
          competitionId,
          lockedCtx
        );
        if (mark !== computed.mark) return 'changed';
        await this.writeLeaderboard(
          computed.competition,
          computed.rows,
          now,
          computed.timeLocked,
          lockedCtx
        );
        return 'written';
      }
    );
    const writeLockedMs = Date.now() - writeStartedAt;
    report.onMeasured?.({ computeMs, writeLockedMs });
    const record = {
      competition_id: competitionId,
      operation: report.operation,
      outcome,
      compute_ms: computeMs,
      locked_ms: writeLockedMs + (report.extraLockedMs ?? 0)
    };
    // 'changed' sends the run to its locked fallback, so it stays visible.
    // LOG_LEVEL_NativeCompetitionRuntimeService=debug shows every refresh.
    if (outcome === 'changed')
      this.logger.info('native_competition_leaderboard_off_lock', record);
    else this.logger.debug('native_competition_leaderboard_off_lock', record);
    return outcome;
  }

  public async processDueCompetitions({
    now = Date.now(),
    timer
  }: { now?: number; timer?: Timer } = {}): Promise<void> {
    const failed = await this.forEachNativeCompetition(
      timer,
      'decisions',
      (competitionId, ctx) => this.processCompetition(competitionId, now, ctx)
    );
    reportLoopHealth({
      operation: 'native_execution',
      pending: failed > 0,
      recovery: 'automatic',
      ...(failed ? {} : { progressAt: Math.floor(Date.now() / 1000) })
    });
  }

  private async forEachNativeCompetition(
    timer: Timer | undefined,
    operation: 'leaderboard' | 'decisions',
    execute: (id: string, ctx: RequestContext) => Promise<void>
  ): Promise<number> {
    let failed = 0;
    let afterId = '';
    for (;;) {
      const ids = await this.repository.discoverCompetitions(afterId, 100, {
        timer
      });
      if (!ids.length) break;
      for (const id of ids) {
        const startedAt = Date.now();
        try {
          await execute(id, { timer });
          this.logger.info('native_competition_execution_completed', {
            competition_id: id,
            operation,
            duration_ms: Date.now() - startedAt
          });
        } catch {
          failed++;
          // Do not log signed payloads, user content or DB error values.
          this.logger.error('native_competition_execution_failed', {
            competition_id: id,
            operation,
            duration_ms: Date.now() - startedAt
          });
        }
      }
      afterId = ids[ids.length - 1];
    }
    return failed;
  }

  public async processCompetition(
    competitionId: string,
    now: number,
    ctx: RequestContext = {}
  ): Promise<void> {
    if (!ctx.connection) {
      const startedAt = Date.now();
      const next = await this.repository.executeNativeQueriesInTransaction(
        (connection) =>
          this.processCompetitionLocked(
            competitionId,
            now,
            { ...ctx, connection },
            true
          )
      );
      let lockedMs = Date.now() - startedAt;
      if (next === 'skipped') return;
      if (next !== 'refresh-off-lock') {
        recordNativeCompetitionRun({
          competitionId,
          operation: 'decisions',
          path: next,
          lockedMs,
          computeMs: 0,
          durationMs: Date.now() - startedAt
        });
        return;
      }
      // A time-locked Rank with nothing due only needs its leaderboard: that
      // is computed off the lock. If its inputs changed meanwhile, the locked
      // run follows once, as before this path existed, so a busy
      // competition's leaderboard is never older than one decision run.
      let computeMs = 0;
      const outcome = await this.refreshLeaderboardOffLock(
        competitionId,
        now,
        ctx,
        {},
        {
          operation: 'decisions',
          extraLockedMs: lockedMs,
          onMeasured: (measured) => {
            computeMs = measured.computeMs;
            lockedMs += measured.writeLockedMs;
          }
        }
      );
      if (outcome === 'changed') {
        const fallbackStartedAt = Date.now();
        await this.repository.executeNativeQueriesInTransaction((connection) =>
          this.processCompetitionLocked(
            competitionId,
            now,
            { ...ctx, connection },
            false
          )
        );
        lockedMs += Date.now() - fallbackStartedAt;
      }
      recordNativeCompetitionRun({
        competitionId,
        operation: 'decisions',
        path: outcome === 'changed' ? 'off_lock_fallback' : 'off_lock',
        lockedMs,
        computeMs,
        durationMs: Date.now() - startedAt
      });
      return;
    }
    await this.processCompetitionLocked(competitionId, now, ctx, false);
  }

  private async processCompetitionLocked(
    competitionId: string,
    now: number,
    ctx: RequestContext,
    offLockRefresh: boolean
  ): Promise<'skipped' | 'static' | 'locked' | 'refresh-off-lock'> {
    const competition = await this.repository.lockCompetition(
      competitionId,
      ctx
    );
    if (
      !competition ||
      competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
      !this.executionRouter.isNativeExecutionAllowed(competition)
    )
      return 'skipped';
    await this.emitScheduledTransitions(competition, now, ctx);
    const undue = await this.undueRank(competition, now, ctx);
    if (undue === 'static') return 'static';
    await this.reconcileCompetitionCredit(competition, now, ctx);
    // Credit stays reconciled under the lock every run; only the time-locked
    // leaderboard computation leaves it.
    if (undue === 'time-locked' && offLockRefresh) return 'refresh-off-lock';
    const state = await this.loadState(competition.id, ctx);
    if (competition.type === CompetitionType.RANK)
      await this.processRank(competition, state, now, ctx);
    else await this.processApprove(competition, state, now, ctx);
    return 'locked';
  }

  /**
   * True when this run has nothing to do for a Rank competition whose
   * leaderboard cannot move with time: no decision is due, the stored next
   * decision time is current, and there is no time lock. Its leaderboard then
   * changes only through votes, entries, pauses or credit, which refresh it
   * themselves or through the leaderboard snapshotter, so the decision run
   * skips the credit reconciliation, state load and leaderboard rewrite it
   * would otherwise repeat every minute under the competition lock.
   * Time-locked and Approve competitions keep the full run: their standings
   * move with time.
   */
  private async undueRank(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<'static' | 'time-locked' | null> {
    if (competition.type !== CompetitionType.RANK) return null;
    const progress = await this.repository.decisionProgress(
      competition.id,
      ctx
    );
    const next = nextNativeDecision(competition.decisions, progress.latest);
    const stored = competition.decisions.next_decision_time;
    // A stale stored time needs processRank's schedule update.
    const undue =
      next !== null &&
      next >= now &&
      stored !== null &&
      Number(stored) === next;
    if (!undue) return null;
    return isTimeLocked(competition) ? 'time-locked' : 'static';
  }

  private async loadState(
    competitionId: string,
    ctx: RequestContext
  ): Promise<RuntimeState> {
    // A transaction connection is sequential; parallel queries cannot improve it.
    const entries = await this.repository.listActiveEntries(competitionId, ctx);
    const history = await this.repository.listHistory(competitionId, ctx);
    const pauses = await this.repository.listPauses(competitionId, ctx);
    return { entries, history, pauses };
  }

  /** Preserve due observations of a configuration before its version changes. */
  public async enqueueDueTransitions(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    if (
      competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
      !this.executionRouter.isNativeExecutionAllowed(competition)
    )
      return;
    await this.emitScheduledTransitions(competition, now, ctx);
  }

  private async emitScheduledTransitions(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const publishedAt = competition.published_at ?? competition.created_at;
    const starts = [
      competition.participation.starts_at,
      competition.voting.starts_at
    ].map((time) => Math.max(time ?? publishedAt, publishedAt));
    const startedAt = Math.min(...starts);
    const configurationActivatedAt =
      competition.configuration_activated_at ?? publishedAt;
    if (startedAt <= now)
      await this.repository.enqueueEvent(
        {
          key: 'started',
          event_type: 'COMPETITION_STARTED',
          competition_id: competition.id,
          wave_id: competition.wave_id,
          occurred_at: startedAt,
          data: {}
        },
        ctx
      );
    const boundaries = Array.from(
      new Set(
        [
          ...starts,
          competition.participation.ends_at,
          competition.voting.ends_at
        ].filter(
          (time): time is number =>
            time !== null &&
            time >= publishedAt &&
            time <= now &&
            time >= configurationActivatedAt
        )
      )
    ).sort((a, b) => a - b);
    for (const boundary of boundaries)
      await this.repository.enqueueEvent(
        {
          key: `phase:${competition.config_version}:${boundary}`,
          event_type: 'COMPETITION_PHASE_CHANGED',
          competition_id: competition.id,
          wave_id: competition.wave_id,
          occurred_at: boundary,
          data: {
            phase: computeCompetitionPhase(competition, boundary),
            config_version: competition.config_version
          }
        },
        ctx
      );
  }

  private scores(
    competition: Competition,
    state: RuntimeState,
    time: number
  ): ScoredEntry[] {
    const timeLock = competition.decisions.time_lock_ms ?? 0;
    const threshold = competition.decisions.winning_min_threshold;
    return state.entries
      .filter((entry) => entry.submitted_at <= time)
      .map((entry) => {
        const points = aggregatePoints(state.history, entry.id);
        const latest = points.filter((point) => point.timestamp <= time).at(-1);
        let previousVote = 0;
        let lastIncreasedAt: number | null = null;
        for (const point of points) {
          if (point.timestamp > time) break;
          if (point.vote > previousVote) lastIncreasedAt = point.timestamp;
          previousVote = point.vote;
        }
        return {
          entry,
          rating: flooredWeightedNativeVote(points, time, timeLock),
          lastChangedAt: latest?.timestamp ?? entry.submitted_at,
          lastIncreasedAt,
          overThresholdSince:
            threshold === null
              ? null
              : nativeThresholdSince(
                  points,
                  time,
                  timeLock,
                  threshold,
                  entry.submitted_at
                )
        };
      });
  }

  private async refreshLeaderboard(
    competition: Competition,
    state: RuntimeState,
    time: number,
    ctx: RequestContext
  ): Promise<void> {
    const { rows, timeLocked } = this.leaderboardRows(competition, state, time);
    await this.writeLeaderboard(competition, rows, time, timeLocked, ctx);
  }

  /** The leaderboard rows for `state` at `time`: pure, no reads or writes. */
  private leaderboardRows(
    competition: Competition,
    state: RuntimeState,
    time: number
  ): { rows: NativeLeaderboardRow[]; timeLocked: boolean } {
    const timeLocked = isTimeLocked(competition);
    const tieTime = (score: ScoredEntry): number =>
      timeLocked ? time : (score.lastIncreasedAt ?? score.entry.submitted_at);
    const scores = this.scores(competition, state, time).sort(
      (a, b) =>
        b.rating - a.rating ||
        tieTime(a) - tieTime(b) ||
        (competition.legacy_origin
          ? a.entry.drop_id
          : a.entry.id
        ).localeCompare(
          competition.legacy_origin ? b.entry.drop_id : b.entry.id
        )
    );
    let rank = 0;
    const decisionRatings = new Map(
      this.scores(
        competition,
        state,
        competition.decisions.next_decision_time ?? time
      ).map((score) => [score.entry.id, score.rating])
    );
    const rows = scores.map((score, index) => {
      const previous = scores[index - 1];
      if (
        !previous ||
        previous.rating !== score.rating ||
        tieTime(previous) !== tieTime(score)
      )
        rank = index + 1;
      return {
        ...score,
        rank,
        orderingTime: tieTime(score),
        decisionRating: decisionRatings.get(score.entry.id) ?? score.rating
      };
    });
    return { rows, timeLocked };
  }

  /** Saves leaderboard rows under the competition lock and announces a change. */
  private async writeLeaderboard(
    competition: Competition,
    rows: NativeLeaderboardRow[],
    time: number,
    timeLocked: boolean,
    ctx: RequestContext
  ): Promise<void> {
    const changed = await this.repository.saveLeaderboard(
      competition.id,
      rows,
      time,
      ctx,
      { timeLocked }
    );
    // Both loops refresh every published competition on a timer (every
    // minute, every 5 minutes). An unchanged snapshot sends nothing: each
    // event goes to every socket that can see the wave, and viewers refetch.
    if (!changed) return;
    await this.repository.enqueueEvent(
      {
        key: `leaderboard:${time}`,
        event_type: 'COMPETITION_LEADERBOARD_UPDATED',
        competition_id: competition.id,
        wave_id: competition.wave_id,
        occurred_at: time,
        data: { snapshot_at: time }
      },
      ctx
    );
  }

  private async processRank(
    competition: Competition,
    state: RuntimeState,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const progress = await this.repository.decisionProgress(
      competition.id,
      ctx
    );
    let next = nextNativeDecision(competition.decisions, progress.latest);
    let count = 0;
    const outcomes = competition.outcome_config as readonly NativeOutcome[];
    while (next !== null && next < now && count < 100) {
      const skipped = isPaused(state.pauses, next);
      const timeLocked = (competition.decisions.time_lock_ms ?? 0) > 0;
      const evaluationTime = timeLocked ? next : now;
      const scores = skipped
        ? []
        : this.scores(competition, state, evaluationTime);
      // Preserve the legacy DECISION tie order (latest increase/change first),
      // distinct from the visible leaderboard's earlier-increase ordering.
      scores.sort(
        (a, b) =>
          b.rating - a.rating ||
          (timeLocked
            ? (b.lastIncreasedAt ?? 0) - (a.lastIncreasedAt ?? 0)
            : b.lastChangedAt - a.lastChangedAt) ||
          (competition.legacy_origin
            ? a.entry.drop_id
            : a.entry.id
          ).localeCompare(
            competition.legacy_origin ? b.entry.drop_id : b.entry.id
          )
      );
      const winners = scores
        .slice(0, nativeWinnerCount(outcomes))
        .map((score, index) => this.winner(score, index + 1));
      await this.finalize(
        competition,
        state,
        winners,
        next,
        now,
        skipped,
        ctx,
        evaluationTime
      );
      next = nextNativeDecision(competition.decisions, next);
      count++;
    }
    const ended =
      (next === null && progress.latest !== null) ||
      (next === null && count > 0);
    await this.repository.updateSchedule(competition.id, next, now, ended, ctx);
    if (ended) await this.emitEnded(competition, now, ctx);
    await this.refreshLeaderboard(competition, state, now, ctx);
  }

  private async processApprove(
    competition: Competition,
    state: RuntimeState,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const time = now;
    await this.refreshLeaderboard(competition, state, time, ctx);
    if (
      competition.voting.starts_at !== null &&
      time < competition.voting.starts_at
    )
      return;
    if (isPaused(state.pauses, time)) return;
    const threshold = competition.decisions.winning_min_threshold;
    if (threshold === null)
      throw new Error('Approve competition requires a threshold');
    const progress = await this.repository.decisionProgress(
      competition.id,
      ctx
    );
    const maxWinners = competition.decisions.max_winners;
    const remaining =
      maxWinners === null
        ? state.entries.length
        : Math.max(0, maxWinners - progress.completed);
    const duration = competition.decisions.winning_threshold_min_duration_ms;
    const eligible = this.scores(competition, state, time)
      .filter(
        (score) =>
          score.rating >= threshold &&
          (duration <= 0 ||
            (score.overThresholdSince !== null &&
              score.overThresholdSince + duration <= time))
      )
      .sort(
        (a, b) =>
          a.entry.submitted_at - b.entry.submitted_at ||
          (competition.legacy_origin
            ? a.entry.drop_id
            : a.entry.id
          ).localeCompare(
            competition.legacy_origin ? b.entry.drop_id : b.entry.id
          )
      )
      .slice(0, remaining);
    let scheduledAt = Math.max(time, (progress.latest ?? 0) + 1);
    let completed = progress.completed;
    for (const score of eligible) {
      if (isPaused(state.pauses, scheduledAt)) break;
      await this.finalize(
        competition,
        state,
        [this.winner(score, 1)],
        scheduledAt,
        now,
        false,
        ctx,
        time
      );
      scheduledAt++;
      completed++;
    }
    const ended = maxWinners !== null && completed >= maxWinners;
    if (ended) await this.endCompetition(competition, now, ctx);
  }

  private async endCompetition(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.repository.updateSchedule(competition.id, null, now, true, ctx);
    await this.emitEnded(competition, now, ctx);
  }

  private winner(score: ScoredEntry, rank: number): NativeDecisionWinner {
    return {
      entry_id: score.entry.id,
      drop_id: score.entry.drop_id,
      submitter_id: score.entry.submitter_id,
      rank,
      final_rating: score.rating
    };
  }

  private async finalize(
    competition: Competition,
    state: RuntimeState,
    winners: readonly NativeDecisionWinner[],
    scheduledAt: number,
    now: number,
    skipped: boolean,
    ctx: RequestContext,
    evaluationTime = scheduledAt
  ): Promise<void> {
    const awards = new Map<string, readonly NativeAward[]>();
    for (const winner of winners)
      awards.set(
        winner.entry_id,
        nativeAwardsForRank(
          competition.outcome_config as readonly NativeOutcome[],
          winner.rank
        )
      );
    await this.repository.saveDecision(
      {
        competition,
        scheduledAt,
        now,
        winners,
        awards,
        skipped,
        voterPoints: voterPoints(state.history),
        finalVote: (points) =>
          flooredWeightedNativeVote(
            points,
            evaluationTime,
            competition.decisions.time_lock_ms ?? 0
          )
      },
      ctx
    );
    const won = new Set(winners.map((winner) => winner.entry_id));
    state.entries = state.entries.filter((entry) => !won.has(entry.id));
  }

  private async emitEnded(
    competition: Competition,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.repository.enqueueEvent(
      {
        key: 'ended:scheduled',
        event_type: 'COMPETITION_ENDED',
        competition_id: competition.id,
        wave_id: competition.wave_id,
        occurred_at: now,
        data: { reason: 'SCHEDULE_COMPLETED' }
      },
      ctx
    );
  }
}

export const nativeCompetitionRuntimeService =
  new NativeCompetitionRuntimeService(
    nativeCompetitionRuntimeRepository,
    competitionCreditService,
    competitionExecutionRouter
  );
