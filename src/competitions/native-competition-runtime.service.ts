import { appFeatures, AppFeatures } from '@/app-features';
import {
  CompetitionCreditService,
  competitionCreditService
} from './competition-credit.service';
import { Competition, CompetitionPause } from './competition.types';
import {
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import {
  competitionExecutionRouter,
  CompetitionExecutionRouter
} from './competition-execution.router';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { computeCompetitionPhase } from './competition-phase';
import {
  NativeCompetitionRuntimeRepository,
  nativeCompetitionRuntimeRepository,
  NativeDecisionWinner,
  NativeHistoryRow,
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
    .filter((row) => row.entry_id === entryId)
    .map((row) => ({
      timestamp: row.occurred_at,
      vote: row.aggregate_value,
      sequence: row.sequence
    }));
}

function voterPoints(
  history: readonly NativeHistoryRow[]
): Map<string, Map<string, NativeVotePoint[]>> {
  const result = new Map<string, Map<string, NativeVotePoint[]>>();
  for (const row of history) {
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
      sequence: row.sequence
    });
  }
  return result;
}

export class NativeCompetitionRuntimeService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly repository: NativeCompetitionRuntimeRepository,
    private readonly credits: Pick<CompetitionCreditService, 'getBudget'>,
    private readonly executionRouter: CompetitionExecutionRouter,
    private readonly features: Pick<
      AppFeatures,
      'isNativeCompetitionExecutionEnabled'
    >
  ) {}

  public async reconcileVoterCredit(
    params: {
      competitionId: string;
      voterProfileId: string;
      availableCredit: number;
      creditScope: string;
      occurredAt: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error(
        'Credit reconciliation requires the competition transaction lock'
      );
    const current = await this.repository.getVoterActiveVotes(
      params.competitionId,
      params.voterProfileId,
      ctx
    );
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
        { ...mutation, previousVote },
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
    for (const voterProfileId of voters) {
      const budget = await this.credits.getBudget(
        competition,
        voterProfileId,
        undefined,
        ctx
      );
      await this.reconcileVoterCredit(
        {
          competitionId: competition.id,
          voterProfileId,
          availableCredit: budget.available,
          creditScope: competition.voting.credit_scope,
          occurredAt: now
        },
        ctx
      );
    }
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
    const state = await this.loadState(competition.id, ctx);
    await this.refreshLeaderboard(competition, state, now, ctx);
  }

  public async refreshNativeLeaderboards(
    timer: Timer,
    now = Date.now()
  ): Promise<void> {
    await this.forEachNativeCompetition(timer, (competitionId, ctx) =>
      this.refreshCompetition(competitionId, now, ctx)
    );
  }

  public async processDueCompetitions({
    now = Date.now(),
    timer
  }: { now?: number; timer?: Timer } = {}): Promise<void> {
    await this.forEachNativeCompetition(timer, (competitionId, ctx) =>
      this.processCompetition(competitionId, now, ctx)
    );
  }

  private async forEachNativeCompetition(
    timer: Timer | undefined,
    execute: (id: string, ctx: RequestContext) => Promise<void>
  ): Promise<void> {
    if (!this.features.isNativeCompetitionExecutionEnabled()) return;
    let afterId = '';
    for (;;) {
      const ids = await this.repository.discoverCompetitions(afterId, 100, {
        timer
      });
      if (!ids.length) break;
      for (const id of ids) {
        try {
          await execute(id, { timer });
        } catch {
          // Do not log signed payloads, user content or DB error values.
          this.logger.error('native_competition_execution_failed', {
            competition_id: id
          });
        }
      }
      afterId = ids[ids.length - 1];
    }
  }

  public async processCompetition(
    competitionId: string,
    now: number,
    ctx: RequestContext = {}
  ): Promise<void> {
    if (!ctx.connection)
      return this.repository.executeNativeQueriesInTransaction((connection) =>
        this.processCompetition(competitionId, now, { ...ctx, connection })
      );
    const competition = await this.repository.lockCompetition(
      competitionId,
      ctx
    );
    if (
      !competition ||
      competition.storage_mode !== CompetitionStorageMode.NATIVE ||
      competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
      !this.executionRouter.isNativeExecutionAllowed(competition)
    )
      return;
    await this.emitScheduledTransitions(competition, now, ctx);
    await this.reconcileCompetitionCredit(competition, now, ctx);
    const state = await this.loadState(competition.id, ctx);
    if (competition.type === CompetitionType.RANK)
      await this.processRank(competition, state, now, ctx);
    else await this.processApprove(competition, state, now, ctx);
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
            time !== null && time >= publishedAt && time <= now
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
    const timeLocked = (competition.decisions.time_lock_ms ?? 0) > 0;
    const tieTime = (score: ScoredEntry): number =>
      timeLocked ? time : (score.lastIncreasedAt ?? score.entry.submitted_at);
    const scores = this.scores(competition, state, time).sort(
      (a, b) =>
        b.rating - a.rating ||
        tieTime(a) - tieTime(b) ||
        a.entry.id.localeCompare(b.entry.id)
    );
    let rank = 0;
    await this.repository.saveLeaderboard(
      competition.id,
      scores.map((score, index) => {
        const previous = scores[index - 1];
        if (
          !previous ||
          previous.rating !== score.rating ||
          tieTime(previous) !== tieTime(score)
        )
          rank = index + 1;
        return { ...score, rank };
      }),
      time,
      ctx
    );
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
          a.entry.id.localeCompare(b.entry.id)
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
          a.entry.id.localeCompare(b.entry.id)
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
    competitionExecutionRouter,
    appFeatures
  );
