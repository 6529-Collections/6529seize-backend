import { legacyCompetitionEntryId } from '@/competitions/competition-id';
import {
  DROPS_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVES_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVES_DECISION_PAUSES_TABLE
} from '@/constants';
import {
  CompetitionCapability,
  CompetitionLifecycle,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  CompetitionRoutingRecord,
  CompetitionSnapshot
} from '@/competitions/competition.types';
import { computeCompetitionPhase } from '@/competitions/competition-phase';
import { LEGACY_PARITY_ROW_LIMIT } from '@/competitions/legacy-parity-snapshot';
import { CompetitionRowLimitError } from '@/competitions/competition-page';

// Closed set of source queries: callers cannot supply SQL fragments.
const LEGACY_SOURCE_QUERIES = {
  drops: `select id, author_id, created_at, drop_type from ${DROPS_TABLE} where wave_id = :waveId and drop_type in ('PARTICIPATORY', 'WINNER') limit :limit`,
  ratings: `select * from ${DROP_RANK_TABLE} where wave_id = :waveId  limit :limit`,
  locked: `select * from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id = :waveId  limit :limit`,
  votes: `select * from ${DROP_VOTER_STATE_TABLE} where wave_id = :waveId  limit :limit`,
  spent: `select * from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where wave_id = :waveId  limit :limit`,
  decisions: `select decision_time from ${WAVES_DECISIONS_TABLE} where wave_id = :waveId order by decision_time asc limit :limit`,
  winners: `select drop_id, decision_time, ranking, final_vote from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id = :waveId order by decision_time asc, ranking asc, drop_id asc limit :limit`,
  outcomes: `select * from ${WAVE_OUTCOMES_TABLE} where wave_id = :waveId order by wave_outcome_position asc limit :limit`,
  distributions: `select * from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id = :waveId order by wave_outcome_distribution_item_position asc limit :limit`,
  pauses: `select start_time, end_time from ${WAVES_DECISION_PAUSES_TABLE} where wave_id = :waveId order by start_time asc, id asc limit :limit`,
  nfts: `select contract, token_id from ${WAVE_VOTING_CREDIT_NFTS_TABLE} where wave_id = :waveId order by contract asc, token_id asc limit :limit`
} as const;

type Numeric = number | string;
type Drop = {
  id: string;
  author_id: string;
  created_at: Numeric;
  drop_type: DropType;
};
type Rating = { drop_id: string; vote: Numeric; last_increased: Numeric };
type LockedRating = { drop_id: string; vote: Numeric; timestamp: Numeric };
type Winner = {
  drop_id: string;
  decision_time: Numeric;
  ranking: Numeric;
  final_vote: Numeric | null;
};
type Vote = { drop_id: string; voter_id: string; votes: Numeric };
type Spend = { drop_id: string; voter_id: string; credit_spent: Numeric };
type Outcome = {
  wave_outcome_position: Numeric;
  type: string;
  subtype: string | null;
  description: string;
  credit: string | null;
  rep_category: string | null;
  amount: Numeric | null;
};
type Distribution = {
  wave_outcome_position: Numeric;
  wave_outcome_distribution_item_position: Numeric;
  amount: Numeric | null;
  description: string | null;
};

const numeric = (value: Numeric | null) =>
  value === null ? null : Number(value);
const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

// Deliberately derives the expected configuration from legacy columns, not from
// LegacyCompetitionAdapter, CompetitionRepository, or native mapping snapshots.
function configuration(wave: WaveEntity, creditNfts: object[], now: number) {
  const participation = {
    group_id: wave.participation_group_id,
    signature_required: Boolean(wave.participation_signature_required),
    max_entries_per_participant: numeric(
      wave.participation_max_applications_per_participant
    ),
    required_metadata: json(wave.participation_required_metadata).map(
      (item) => ({ ...item })
    ),
    required_media: json(wave.participation_required_media),
    submission_type: wave.submission_type,
    identity_submission_strategy: wave.identity_submission_strategy,
    identity_submission_duplicates: wave.identity_submission_duplicates,
    starts_at: numeric(wave.participation_period_start),
    ends_at: numeric(wave.participation_period_end),
    terms: wave.participation_terms
  };
  const voting = {
    group_id: wave.voting_group_id,
    credit_type: wave.voting_credit_type,
    credit_scope: wave.voting_credit_scope,
    credit_category: wave.voting_credit_category,
    credit_creditor: wave.voting_credit_creditor,
    credit_nfts: creditNfts as Record<string, unknown>[],
    signature_required: Boolean(wave.voting_signature_required),
    starts_at: numeric(wave.voting_period_start),
    ends_at: numeric(wave.voting_period_end),
    max_votes_per_identity_to_entry: numeric(
      wave.max_votes_per_identity_to_drop
    ),
    forbid_negative_votes: Boolean(wave.forbid_negative_votes)
  };
  const winners = {
    max_winners: numeric(wave.max_winners),
    winning_min_threshold: numeric(wave.winning_min_threshold),
    winning_max_threshold: numeric(wave.winning_max_threshold),
    winning_threshold_min_duration_ms: Number(
      wave.winning_threshold_min_duration_ms
    )
  };
  const decisions = {
    ...winners,
    strategy: json(wave.decisions_strategy) as Record<string, unknown> | null,
    next_decision_time: numeric(wave.next_decision_time),
    time_lock_ms: numeric(wave.time_lock_ms)
  };
  const ends = [participation.ends_at, voting.ends_at].filter(
    (end): end is number => end !== null
  );
  const ended =
    ends.length > 0 &&
    ends.every((end) => end <= now) &&
    decisions.next_decision_time === null;
  const lifecycle = ended
    ? CompetitionLifecycle.ENDED
    : CompetitionLifecycle.PUBLISHED;
  return {
    type: wave.type,
    title: wave.name,
    lifecycle,
    computed_phase: computeCompetitionPhase(
      { lifecycle, participation, voting, decisions },
      now
    ),
    participation,
    voting,
    decisions,
    winners,
    created_at: Number(wave.created_at),
    updated_at: numeric(wave.updated_at) ?? Number(wave.created_at),
    // The existing public legacy projection treats epoch zero as no end date.
    ended_at: ended && Math.max(...ends) !== 0 ? Math.max(...ends) : null
  };
}

function ratedDrops(drops: Drop[], ratings: Rating[], locked?: LockedRating[]) {
  const live = new Map(ratings.map((row) => [row.drop_id, row]));
  const snapshots = new Map((locked ?? []).map((row) => [row.drop_id, row]));
  return drops
    .map((drop) => {
      const rating = live.get(drop.id);
      const snapshot = snapshots.get(drop.id);
      return {
        drop_id: drop.id,
        submitted_at: Number(drop.created_at),
        rating: Number(locked ? (snapshot?.vote ?? 0) : (rating?.vote ?? 0)),
        real_time_rating: Number(rating?.vote ?? 0),
        tie: Number(
          locked
            ? (snapshot?.timestamp ?? drop.created_at)
            : (rating?.last_increased ?? drop.created_at)
        )
      };
    })
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        a.tie - b.tie ||
        a.drop_id.localeCompare(b.drop_id)
    );
}

function ranks(rows: ReturnType<typeof ratedDrops>) {
  let rank = 0;
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    if (!previous || previous.rating !== row.rating || previous.tie !== row.tie)
      rank = index + 1;
    const { tie: _tie, ...entry } = row;
    return { ...entry, rank };
  });
}

function entries(drops: Drop[], ratings: Rating[], winners: Winner[]) {
  const rankByDrop = new Map(
    ranks(ratedDrops(drops, ratings)).map((row) => [row.drop_id, row.rank])
  );
  const latest = new Map<string, Winner>();
  for (const winner of winners) {
    const previous = latest.get(winner.drop_id);
    if (
      !previous ||
      Number(winner.decision_time) > Number(previous.decision_time)
    )
      latest.set(winner.drop_id, winner);
  }
  return drops
    .map((drop) => {
      const winner = latest.get(drop.id);
      return {
        drop_id: drop.id,
        submitter_id: drop.author_id,
        status: drop.drop_type === DropType.WINNER ? 'WINNER' : 'ACTIVE',
        submitted_at: Number(drop.created_at),
        rank: winner
          ? Number(winner.ranking)
          : (rankByDrop.get(drop.id) ?? null),
        won_at: winner ? Number(winner.decision_time) : null
      };
    })
    .sort((a, b) => a.drop_id.localeCompare(b.drop_id));
}

function voters(votes: Vote[], spendings: Spend[]) {
  const spent = new Map<string, number>();
  for (const row of spendings) {
    const key = JSON.stringify([row.drop_id, row.voter_id]);
    spent.set(key, (spent.get(key) ?? 0) + Number(row.credit_spent));
  }
  const byVoter = new Map<
    string,
    { profile_id: string; votes: number; credit_spent: number }
  >();
  for (const row of votes) {
    const voter = byVoter.get(row.voter_id) ?? {
      profile_id: row.voter_id,
      votes: 0,
      credit_spent: 0
    };
    voter.votes += Number(row.votes);
    voter.credit_spent +=
      spent.get(JSON.stringify([row.drop_id, row.voter_id])) ?? 0;
    byVoter.set(row.voter_id, voter);
  }
  return Array.from(byVoter.values()).sort((a, b) =>
    a.profile_id.localeCompare(b.profile_id)
  );
}

function capabilities(waveId: string) {
  return [
    CompetitionCapability.MAIN_STAGE,
    CompetitionCapability.CURATION,
    CompetitionCapability.QUORUM,
    CompetitionCapability.ANNOUNCEMENTS
  ]
    .filter((capability) => process.env[`${capability}_WAVE_ID`] === waveId)
    .sort((a, b) => a.localeCompare(b));
}

/** Independent oracle over authoritative legacy tables; never reads native rows. */
export class LegacyCompetitionBaselineRepository extends LazyDbAccessCompatibleService {
  public async getSnapshot(
    record: CompetitionRoutingRecord,
    now: number,
    ctx: RequestContext
  ): Promise<CompetitionSnapshot> {
    const timerName = `${this.constructor.name}->getSnapshot`;
    ctx.timer?.start(timerName);
    try {
      return await this.load(record, now, ctx);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async rows<T>(
    source: keyof typeof LEGACY_SOURCE_QUERIES,
    waveId: string,
    ctx: RequestContext
  ): Promise<T[]> {
    const rows = await this.db.execute<T>(
      LEGACY_SOURCE_QUERIES[source],
      { waveId, limit: LEGACY_PARITY_ROW_LIMIT + 1 },
      { wrappedConnection: ctx.connection }
    );
    if (rows.length > LEGACY_PARITY_ROW_LIMIT)
      throw new CompetitionRowLimitError();
    return rows;
  }

  private async load(
    record: CompetitionRoutingRecord,
    now: number,
    ctx: RequestContext
  ): Promise<CompetitionSnapshot> {
    const wave = await this.db.oneOrNull<WaveEntity>(
      `select * from ${WAVES_TABLE} where id = :waveId`,
      { waveId: record.wave_id },
      { wrappedConnection: ctx.connection }
    );
    if (!wave || wave.type === WaveType.CHAT)
      throw new Error('Legacy baseline wave unavailable');
    const read = <T>(source: keyof typeof LEGACY_SOURCE_QUERIES) =>
      this.rows<T>(source, record.wave_id, ctx);
    const drops = await read<Drop>('drops');
    const ratings = await read<Rating>('ratings');
    const locked = await read<LockedRating>('locked');
    const votes = await read<Vote>('votes');
    const spent = await read<Spend>('spent');
    const decisions = await read<{ decision_time: Numeric }>('decisions');
    const winners = await read<Winner>('winners');
    const outcomes = await read<Outcome>('outcomes');
    const distributions = await read<Distribution>('distributions');
    const pauses = await read<{
      start_time: Numeric;
      end_time: Numeric | null;
    }>('pauses');
    const nfts = await read<object>('nfts');
    const activeDrops = drops.filter(
      (drop) => drop.drop_type === DropType.PARTICIPATORY
    );
    // An enabled lock with no snapshot must still project zero, not live votes.
    const leaderboardRatings =
      Number(wave.time_lock_ms) > 0 ? locked : undefined;
    const rated = ratedDrops(activeDrops, ratings, leaderboardRatings);
    return {
      storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
      config_version: Number(record.config_version ?? 1),
      configuration: configuration(wave, nfts, now),
      entries: entries(drops, ratings, winners),
      votes_and_credits: voters(votes, spent),
      leaderboard: ranks(rated),
      decisions_and_winners: decisions.map((decision) => ({
        scheduled_at: Number(decision.decision_time),
        decided_at: Number(decision.decision_time),
        status: 'COMPLETED',
        winners: winners
          .filter(
            (winner) =>
              Number(winner.decision_time) === Number(decision.decision_time)
          )
          .map((winner) => ({
            entry_id: legacyCompetitionEntryId(record.id, winner.drop_id),
            rank: Number(winner.ranking),
            final_rating: Number(winner.final_vote ?? 0)
          }))
      })),
      outcomes_and_distributions: outcomes.map((outcome) => ({
        position: Number(outcome.wave_outcome_position),
        type: outcome.type,
        subtype: outcome.subtype,
        description: outcome.description,
        credit: outcome.credit,
        rep_category: outcome.rep_category,
        amount: numeric(outcome.amount),
        distribution: distributions
          .filter(
            (item) =>
              Number(item.wave_outcome_position) ===
              Number(outcome.wave_outcome_position)
          )
          .map((item) => ({
            position: Number(item.wave_outcome_distribution_item_position),
            amount: numeric(item.amount),
            description: item.description
          }))
      })),
      pauses: pauses.map((pause) => ({
        start_time: Number(pause.start_time),
        end_time: numeric(pause.end_time)
      })),
      capabilities: capabilities(record.wave_id)
    };
  }
}

export const legacyCompetitionBaselineRepository =
  new LegacyCompetitionBaselineRepository(dbSupplier);
