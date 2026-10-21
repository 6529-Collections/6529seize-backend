import { memeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import { competitionMainStageRepository } from './competition-main-stage.repository';
import { legacyGetView } from './legacy-competition-get-facade';
import { randomUUID } from 'node:crypto';
import {
  nativeScoreSequence,
  NATIVE_SCORE_SEQUENCE_BASE
} from '@/competitions/competition-score-history';
import { collections } from '@/collections';
import { readSequentially } from '@/competitions/competition-read-sequence';
import {
  mirrorNativeLegacyVote,
  mirrorNativeLegacyVoteActivity,
  mirrorNativeLegacyWinners,
  mirrorNativeLegacySchedule
} from '@/competitions/legacy-competition-mirror';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
} from '@/constants';
import {
  CompetitionCapability,
  CompetitionDecisionStatus
} from '@/entities/ICompetition';
import { RequestContext } from '@/request.context';
import { BadRequestException } from '@/exceptions';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  Competition,
  CompetitionEntry,
  CompetitionPause
} from './competition.types';
import { competitionRepository } from './competition.repository';
import { NativeCompetitionReader } from './native-competition.reader';
import { stableUuid } from './competition-id';
import {
  NativeAward,
  NativeVotePoint
} from './native-competition-runtime.helpers';

export type NativeRuntimeEntry = CompetitionEntry & {
  readonly real_time_rating: number;
  readonly last_increased_at: number | null;
};

export type NativeHistoryRow = {
  readonly kind?: 'AGGREGATE' | 'VOTER';
  readonly entry_id: string;
  readonly voter_profile_id: string;
  readonly value: number;
  readonly aggregate_value: number;
  readonly occurred_at: number;
  readonly sequence: number;
  readonly order_sequence?: number;
};

export type NativeCompetitionEvent = {
  readonly event_id: string;
  readonly event_version: 1;
  readonly event_type: string;
  readonly occurred_at: number;
  readonly wave_id: string;
  readonly competition_id: string;
  readonly competition_entry_id?: string;
  readonly drop_id?: string;
  readonly data: Record<string, unknown>;
};

export type NativeCompetitionOutboxRecord = {
  readonly id: string;
  readonly event: NativeCompetitionEvent;
  readonly lease_token: string;
  readonly attempts: number;
};

export type NativeDecisionWinner = {
  readonly entry_id: string;
  readonly drop_id: string;
  readonly submitter_id: string;
  readonly rank: number;
  readonly final_rating: number;
};

export type NativeDecisionAward = NativeAward & {
  readonly id: string;
  readonly competition_id: string;
  readonly decision_id: string;
  readonly entry_id: string;
};

function safeAggregateRating(value: number | string): number {
  const rating = Number(value);
  if (!Number.isSafeInteger(rating))
    throw new BadRequestException(
      'Entry aggregate vote must remain within the safe integer range'
    );
  return rating;
}

/** All state changes require the caller's competition row lock. The lock is
 * also the execution lease: it is released atomically with commit/rollback. */
export class NativeCompetitionRuntimeRepository extends LazyDbAccessCompatibleService {
  private requireTransaction(ctx: RequestContext): void {
    if (!ctx.connection)
      throw new Error('Native competition runtime requires a transaction');
  }

  private async query<T>(
    operation: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${operation}`;
    try {
      ctx.timer?.start(name);
      return await this.db.execute<T>(
        sql,
        params,
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(name);
    }
  }

  public async discoverCompetitions(
    afterId: string,
    limit: number,
    ctx: RequestContext
  ): Promise<string[]> {
    const rows = await this.query<{ id: string }>(
      'discoverCompetitions',
      `select id from ${COMPETITIONS_TABLE}
      where storage_mode = 'NATIVE' and execution_mode = 'ACTIVE' and lifecycle = 'PUBLISHED'
      and id > :afterId order by id asc limit :limit`,
      { afterId, limit },
      ctx
    );
    return rows.map((row) => row.id);
  }

  public async lockCompetition(
    competitionId: string,
    ctx: RequestContext
  ): Promise<Competition | null> {
    this.requireTransaction(ctx);
    const rows = await this.query<{ id: string }>(
      'lockCompetition',
      `select id from ${COMPETITIONS_TABLE} where id = :competitionId for update`,
      { competitionId },
      ctx
    );
    if (!rows.length) return null;
    const record = await competitionRepository.findCompetitionRecordById(
      competitionId,
      ctx
    );
    if (!record || record.storage_mode !== 'NATIVE') return null;
    return new NativeCompetitionReader(
      competitionRepository,
      ctx
    ).getCompetition(record, Date.now());
  }

  public async listActiveEntries(
    competitionId: string,
    ctx: RequestContext
  ): Promise<NativeRuntimeEntry[]> {
    const rows = await this.query<NativeRuntimeEntry>(
      'listActiveEntries',
      `select e.*,
      coalesce(r.real_time_rating, 0) as real_time_rating, r.last_increased_at
      from ${COMPETITION_ENTRIES_TABLE} e left join ${COMPETITION_ENTRY_RUNTIME_TABLE} r
      on r.competition_id = e.competition_id and r.entry_id = e.id
      where e.competition_id = :competitionId and e.status = 'ACTIVE'
      order by e.submitted_at asc, e.id asc`,
      { competitionId },
      ctx
    );
    return rows.map((row) => ({
      ...row,
      submitted_at: Number(row.submitted_at),
      real_time_rating: safeAggregateRating(row.real_time_rating),
      last_increased_at:
        row.last_increased_at === null ? null : Number(row.last_increased_at)
    }));
  }

  public async listHistory(
    competitionId: string,
    ctx: RequestContext
  ): Promise<NativeHistoryRow[]> {
    const resets = `with score_resets as (
      select json_unquote(json_extract(event,'$.competition_entry_id')) as entry_id,event,
        row_number() over (partition by json_unquote(json_extract(event,'$.competition_entry_id'))
          order by cast(json_unquote(json_extract(event,'$.data.content_revision')) as unsigned) desc,created_at desc,id desc) as reset_order
      from ${COMPETITION_OUTBOX_TABLE} where competition_id=:competitionId
        and json_unquote(json_extract(event,'$.event_type'))='COMPETITION_ENTRY_UPDATED'
        and json_contains_path(event,'all','$.data.vote_history_sequence','$.data.aggregate_history_sequence','$.data.voter_history_sequence')
    )`;
    const legacy = await this.query<{ wave_id: string }>(
      'retainedLegacyHistory',
      `select wave_id from ${COMPETITIONS_TABLE} where id=:competitionId and legacy_wave_id=wave_id and storage_mode='NATIVE'`,
      { competitionId },
      ctx
    );
    if (legacy.length) {
      // Aggregate and voter histories have independent source identities. They
      // must never be joined by timestamp or invented from current totals.
      const read = async (table: string, kind: 'AGGREGATE' | 'VOTER') =>
        this.query<NativeHistoryRow>(
          'retainedLegacyHistory',
          `${resets} select e.id as entry_id,${kind === 'VOTER' ? 'h.voter_id' : "''"} as voter_profile_id,
          ${kind === 'VOTER' ? 'h.vote' : '0'} as value,${kind === 'AGGREGATE' ? 'h.vote' : '0'} as aggregate_value,
          h.timestamp as occurred_at,h.id as sequence,'${kind}' as kind,
          if(score.mutation_sequence is null,h.id,:base+score.mutation_sequence) as order_sequence
          from ${legacyGetView(table)} h join ${COMPETITION_ENTRIES_TABLE} e on e.drop_id=h.drop_id and e.competition_id=:competitionId
          left join ${COMPETITION_SCORE_HISTORY_TABLE} score on score.competition_id=:competitionId and score.kind=:kind and score.sequence=h.id
          left join score_resets revision_reset on revision_reset.entry_id=e.id and revision_reset.reset_order=1
          where h.wave_id=:waveId and e.status='ACTIVE' and (revision_reset.entry_id is null
            or (score.mutation_sequence is not null and score.mutation_sequence>
              cast(json_unquote(json_extract(revision_reset.event,'$.data.vote_history_sequence')) as unsigned))
            or (score.mutation_sequence is null and h.id>
              cast(json_unquote(json_extract(revision_reset.event,'$.data.${kind === 'AGGREGATE' ? 'aggregate_history_sequence' : 'voter_history_sequence'}')) as unsigned)))
          order by h.timestamp,order_sequence`,
          {
            competitionId,
            waveId: legacy[0].wave_id,
            kind,
            base: NATIVE_SCORE_SEQUENCE_BASE
          },
          ctx
        );
      const history = [
        ...(await read(DROP_REAL_VOTE_IN_TIME_TABLE, 'AGGREGATE')),
        ...(await read(DROP_REAL_VOTER_VOTE_IN_TIME_TABLE, 'VOTER'))
      ];
      return history
        .map((row) => ({
          ...row,
          value: Number(row.value),
          aggregate_value: safeAggregateRating(row.aggregate_value),
          occurred_at: Number(row.occurred_at),
          sequence: Number(row.sequence),
          order_sequence: Number(row.order_sequence)
        }))
        .sort(
          (a, b) =>
            a.occurred_at - b.occurred_at ||
            a.order_sequence - b.order_sequence ||
            (a.kind ?? '').localeCompare(b.kind ?? '')
        );
    }
    const rows = await this.query<NativeHistoryRow>(
      'listHistory',
      `${resets} select h.* from ${COMPETITION_VOTE_HISTORY_TABLE} h
      join ${COMPETITION_ENTRIES_TABLE} e on e.id = h.entry_id and e.competition_id = h.competition_id
      left join score_resets revision_reset on revision_reset.entry_id=e.id and revision_reset.reset_order=1
      where h.competition_id = :competitionId and e.status = 'ACTIVE'
      and (revision_reset.entry_id is null or h.sequence>cast(json_unquote(json_extract(revision_reset.event,'$.data.vote_history_sequence')) as unsigned))
      order by h.occurred_at asc, h.sequence asc`,
      { competitionId },
      ctx
    );
    return rows.map((row) => ({
      ...row,
      value: Number(row.value),
      aggregate_value: safeAggregateRating(row.aggregate_value),
      occurred_at: Number(row.occurred_at),
      sequence: Number(row.sequence)
    }));
  }

  public async listActiveVoters(
    competitionId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const rows = await this.query<{ voter_profile_id: string }>(
      'listActiveVoters',
      `select distinct v.voter_profile_id
      from ${COMPETITION_VOTES_TABLE} v join ${COMPETITION_ENTRIES_TABLE} e on e.id = v.entry_id and e.competition_id = v.competition_id
      where v.competition_id = :competitionId and e.status = 'ACTIVE' and v.value <> 0 order by v.voter_profile_id asc`,
      { competitionId },
      ctx
    );
    return rows.map((row) => row.voter_profile_id);
  }

  public async getVoterActiveVotes(
    competitionId: string,
    voterProfileId: string,
    ctx: RequestContext
  ): Promise<{ entryId: string; value: number }[]> {
    const rows = await this.query<{ entryId: string; value: number }>(
      'getVoterActiveVotes',
      `select v.entry_id as entryId, v.value
      from ${COMPETITION_VOTES_TABLE} v join ${COMPETITION_ENTRIES_TABLE} e on e.id = v.entry_id and e.competition_id = v.competition_id
      where v.competition_id = :competitionId and v.voter_profile_id = :voterProfileId and e.status = 'ACTIVE'
      order by v.updated_at asc, v.entry_id asc`,
      { competitionId, voterProfileId },
      ctx
    );
    return rows.map((row) => ({ ...row, value: Number(row.value) }));
  }

  public async replaceVoteForReconciliation(
    params: {
      competitionId: string;
      entryId: string;
      voterProfileId: string;
      value: number;
      occurredAt: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    this.requireTransaction(ctx);
    await this.query(
      'replaceVoteForReconciliation',
      `update ${COMPETITION_VOTES_TABLE} set value = :value,
      credit_spent = abs(:value), updated_at = :occurredAt where competition_id = :competitionId and entry_id = :entryId and voter_profile_id = :voterProfileId`,
      params,
      ctx
    );
  }

  public async recordVoteChange(
    params: {
      competitionId: string;
      entryId: string;
      voterProfileId: string;
      previousVote: number;
      value: number;
      occurredAt: number;
      proxyId?: string | null;
      reason?: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    this.requireTransaction(ctx);
    if (params.previousVote === params.value) return;
    const [entry] = await this.query<{
      wave_id: string;
      drop_id: string;
      submitter_id: string;
      legacy_primary: number | null;
    }>(
      'recordVoteChange',
      `select e.wave_id, e.drop_id, e.submitter_id, c.legacy_wave_id = c.wave_id as legacy_primary
      from ${COMPETITION_ENTRIES_TABLE} e join ${COMPETITIONS_TABLE} c on c.id = e.competition_id
      where e.competition_id = :competitionId and e.id = :entryId and e.status = 'ACTIVE'`,
      params,
      ctx
    );
    if (!entry) throw new Error('Native vote history requires an active entry');
    const [aggregate] = await this.query<{ value: string }>(
      'recordVoteChange',
      `select cast(coalesce(sum(value), 0) as char) as value from ${COMPETITION_VOTES_TABLE}
      where competition_id = :competitionId and entry_id = :entryId`,
      params,
      ctx
    );
    // Keep the exact SQL sum until its representability is checked. Throwing
    // here rolls back the caller's vote, receipt and metrics transaction too.
    const aggregateValue = safeAggregateRating(aggregate.value);
    const increasedAt =
      params.value > params.previousVote ? params.occurredAt : null;
    await this.query(
      'recordVoteChange',
      `insert into ${COMPETITION_ENTRY_RUNTIME_TABLE}
      (competition_id, entry_id, real_time_rating, last_increased_at, over_threshold_since, updated_at)
      values (:competitionId, :entryId, :aggregateValue, :increasedAt, null, :occurredAt)
      on duplicate key update real_time_rating = :aggregateValue, last_increased_at = coalesce(:increasedAt, last_increased_at), updated_at = :occurredAt`,
      { ...params, aggregateValue, increasedAt },
      ctx
    );
    await this.query(
      'recordVoteChange',
      `insert into ${COMPETITION_VOTE_HISTORY_TABLE}
      (competition_id, entry_id, voter_profile_id, value, previous_value, aggregate_value, credit_delta, occurred_at, drop_id, submitter_id, proxy_id, contents)
      values (:competitionId, :entryId, :voterProfileId, :value, :previousVote, :aggregateValue, :creditDelta, :occurredAt, :dropId, :submitterId, :proxyId, :contents)`,
      {
        ...params,
        aggregateValue,
        dropId: entry.drop_id,
        submitterId: entry.submitter_id,
        proxyId: params.proxyId ?? null,
        contents: JSON.stringify({
          oldVote: params.previousVote,
          newVote: params.value,
          ...(params.reason ? { reason: params.reason } : {})
        }),
        creditDelta: Math.abs(params.value) - Math.abs(params.previousVote)
      },
      ctx
    );
    const sequence = await this.getLastInsertId(ctx.connection!);
    await mirrorNativeLegacyVote(this.db, params, ctx, sequence);
    if (Number(entry.legacy_primary) !== 1) {
      await this.query(
        'recordVoteScoreHistory',
        `insert into ${COMPETITION_SCORE_HISTORY_TABLE}
        (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at,mutation_sequence)
        values (:competitionId,'AGGREGATE',:scoreSequence,:entryId,:dropId,'',:aggregateValue,:occurredAt,:sequence),
        (:competitionId,'VOTER',:scoreSequence,:entryId,:dropId,:voterProfileId,:value,:occurredAt,:sequence)`,
        {
          ...params,
          sequence,
          dropId: entry.drop_id,
          aggregateValue,
          scoreSequence: nativeScoreSequence(sequence)
        },
        ctx
      );
    }
    if (Number(entry.legacy_primary) === 1) {
      await mirrorNativeLegacyVoteActivity(this.db, params, sequence, ctx);
    }
    await this.enqueueEvent(
      {
        key: `vote:${sequence}`,
        event_type: 'COMPETITION_VOTE_CHANGED',
        wave_id: entry.wave_id,
        competition_id: params.competitionId,
        competition_entry_id: params.entryId,
        drop_id: entry.drop_id,
        occurred_at: params.occurredAt,
        data: { aggregate_rating: aggregateValue, version: sequence }
      },
      ctx
    );
  }

  public async saveLeaderboard(
    competitionId: string,
    entries: readonly {
      entry: NativeRuntimeEntry;
      rating: number;
      rank: number;
      overThresholdSince: number | null;
      orderingTime?: number;
      decisionRating?: number;
    }[],
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    this.requireTransaction(ctx);
    await readSequentially(
      collections.chunkArray([...entries], 100),
      async (page) => {
        await this.db.bulkUpsert(
          COMPETITION_LEADERBOARD_ENTRIES_TABLE,
          page.map((row) => ({
            competition_id: competitionId,
            entry_id: row.entry.id,
            drop_id: row.entry.drop_id,
            rating: row.rating,
            real_time_rating: row.entry.real_time_rating,
            rank: row.rank,
            submitted_at: row.entry.submitted_at,
            updated_at: now,
            ordering_time: row.orderingTime ?? now,
            decision_rating: row.decisionRating ?? row.rating,
            over_threshold_since: row.overThresholdSince
          })),
          [
            'competition_id',
            'entry_id',
            'drop_id',
            'rating',
            'real_time_rating',
            'rank',
            'submitted_at',
            'updated_at',
            'ordering_time',
            'decision_rating',
            'over_threshold_since'
          ],
          [
            'rating',
            'real_time_rating',
            'rank',
            'updated_at',
            'ordering_time',
            'decision_rating',
            'over_threshold_since'
          ],
          ctx
        );
        const params: Record<string, unknown> = {
          competitionId,
          entryIds: page.map((row) => row.entry.id)
        };
        await this.query(
          'publishLeaderboardSnapshot',
          `update ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} leaderboard
          join ${COMPETITIONS_TABLE} competition on competition.id=leaderboard.competition_id
          set leaderboard.published_at=:now
          where leaderboard.competition_id=:competitionId and leaderboard.entry_id in (:entryIds)
          and cast(coalesce(nullif(json_unquote(json_extract(competition.decision_config,'$.time_lock_ms')),'null'),'0') as signed)>0`,
          { ...params, now },
          ctx
        );
        const cases = page.map((row, index) => {
          params[`entry${index}`] = row.entry.id;
          params[`threshold${index}`] = row.overThresholdSince;
          return `when :entry${index} then :threshold${index}`;
        });
        await this.query(
          'saveLeaderboard',
          `update ${COMPETITION_ENTRY_RUNTIME_TABLE}
        set over_threshold_since = case entry_id ${cases.join(' ')} else over_threshold_since end
        where competition_id = :competitionId and entry_id in (:entryIds)`,
          params,
          ctx
        );
      }
    );
    await this.query(
      'saveLeaderboard',
      `delete lb from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb
      left join ${COMPETITION_ENTRIES_TABLE} e on e.id = lb.entry_id and e.competition_id = lb.competition_id
      where lb.competition_id = :competitionId
        and ((e.id is null and lb.published_at is null) or (e.id is not null and e.status <> 'ACTIVE'))`,
      { competitionId },
      ctx
    );
  }

  public async listPauses(
    competitionId: string,
    ctx: RequestContext
  ): Promise<CompetitionPause[]> {
    const rows = await this.query<CompetitionPause>(
      'listPauses',
      `select * from ${COMPETITION_PAUSES_TABLE} where competition_id = :competitionId order by start_time asc, id asc`,
      { competitionId },
      ctx
    );
    return rows.map((row) => ({
      ...row,
      start_time: Number(row.start_time),
      end_time: row.end_time === null ? null : Number(row.end_time)
    }));
  }

  public async decisionProgress(
    competitionId: string,
    ctx: RequestContext
  ): Promise<{ latest: number | null; completed: number }> {
    const [row] = await this.query<{
      latest: number | null;
      completed: number;
    }>(
      'decisionProgress',
      `select max(scheduled_at) as latest,
      coalesce(sum(case when status = 'COMPLETED' then 1 else 0 end), 0) as completed from ${COMPETITION_DECISIONS_TABLE} where competition_id = :competitionId`,
      { competitionId },
      ctx
    );
    return {
      latest: row.latest === null ? null : Number(row.latest),
      completed: Number(row.completed)
    };
  }

  public async saveDecision(
    params: {
      competition: Competition;
      scheduledAt: number;
      now: number;
      winners: readonly NativeDecisionWinner[];
      awards: ReadonlyMap<string, readonly NativeAward[]>;
      voterPoints: ReadonlyMap<
        string,
        ReadonlyMap<string, readonly NativeVotePoint[]>
      >;
      finalVote: (points: readonly NativeVotePoint[]) => number;
      skipped: boolean;
      decisionKey?: string;
    },
    ctx: RequestContext
  ): Promise<string> {
    this.requireTransaction(ctx);
    const competitionId = params.competition.id;
    const decisionId = stableUuid(
      competitionId,
      `decision:${params.scheduledAt}`
    );
    const existing = await this.query<{ id: string }>(
      'saveDecision',
      `select id from ${COMPETITION_DECISIONS_TABLE} where id = :decisionId`,
      { decisionId },
      ctx
    );
    if (existing.length && !params.decisionKey) return decisionId;
    if (!existing.length)
      await this.query(
        'saveDecision',
        `insert into ${COMPETITION_DECISIONS_TABLE}
      (id, competition_id, scheduled_at, decided_at, status, execution_key, created_at)
      values (:decisionId, :competitionId, :scheduledAt, :now, :status, :executionKey, :now)`,
        {
          decisionId,
          competitionId,
          scheduledAt: params.scheduledAt,
          now: params.now,
          status: params.skipped
            ? CompetitionDecisionStatus.CANCELLED
            : CompetitionDecisionStatus.COMPLETED,
          executionKey: `native:${competitionId}:${params.scheduledAt}`
        },
        ctx
      );
    for (const winner of params.winners) {
      await this.saveWinner(
        {
          competitionId,
          decisionId,
          winner,
          scheduledAt: params.scheduledAt,
          now: params.now
        },
        ctx
      );
      await this.enqueueEvent(
        {
          key: `winner:${decisionId}:${winner.entry_id}`,
          event_type: 'COMPETITION_ENTRY_STATUS_CHANGED',
          competition_id: competitionId,
          wave_id: params.competition.wave_id,
          competition_entry_id: winner.entry_id,
          drop_id: winner.drop_id,
          occurred_at: params.now,
          data: {
            previous_status: 'ACTIVE',
            status: 'WINNER',
            decision_id: decisionId
          }
        },
        ctx
      );
      for (const [voterId, points] of Array.from(
        params.voterPoints.get(winner.entry_id)?.entries() ?? []
      )) {
        await this.query(
          'saveDecision',
          `insert into ${COMPETITION_WINNER_VOTES_TABLE}
          (competition_id, decision_id, entry_id, voter_profile_id, value) values (:competitionId, :decisionId, :entryId, :voterId, :value)`,
          {
            competitionId,
            decisionId,
            entryId: winner.entry_id,
            voterId,
            value: params.finalVote(points)
          },
          ctx
        );
      }
      for (const award of params.awards.get(winner.entry_id) ?? []) {
        const id = stableUuid(
          decisionId,
          `award:${winner.entry_id}:${award.outcome_position}`
        );
        await this.query(
          'saveDecision',
          `insert into ${COMPETITION_OUTCOME_AWARDS_TABLE}
          (id, competition_id, decision_id, entry_id, outcome_position, award, created_at)
          values (:id, :competitionId, :decisionId, :entryId, :position, :award, :now)`,
          {
            id,
            competitionId,
            decisionId,
            entryId: winner.entry_id,
            position: award.outcome_position,
            award: JSON.stringify(award),
            now: params.now
          },
          ctx
        );
        await this.enqueueEvent(
          {
            key: `award:${id}`,
            event_type: 'COMPETITION_OUTCOME_CREATED',
            competition_id: competitionId,
            wave_id: params.competition.wave_id,
            competition_entry_id: winner.entry_id,
            drop_id: winner.drop_id,
            occurred_at: params.now,
            data: {
              decision_id: decisionId,
              outcome_award_id: id,
              outcome_position: award.outcome_position
            }
          },
          ctx
        );
      }
    }
    if (
      !params.skipped &&
      params.competition.capabilities.includes(
        CompetitionCapability.MAIN_STAGE
      ) &&
      (await competitionMainStageRepository.isDesignated(competitionId, ctx))
    ) {
      const nextMint = params.winners.find((winner) => winner.rank === 1);
      if (nextMint)
        await memeCollaborationsService.freezeForMint(nextMint.drop_id, ctx);
    }
    if (!params.skipped)
      await this.enqueueEvent(
        {
          key: `decision:${decisionId}${params.decisionKey ? `:${params.decisionKey}` : ''}`,
          event_type: 'COMPETITION_DECISION_COMPLETED',
          competition_id: competitionId,
          wave_id: params.competition.wave_id,
          occurred_at: params.now,
          data: {
            decision_id: decisionId,
            scheduled_at: params.scheduledAt,
            winners: params.winners,
            capabilities: params.competition.capabilities
          }
        },
        ctx
      );
    await mirrorNativeLegacyWinners(
      this.db,
      competitionId,
      params.winners.map((winner) => winner.drop_id),
      ctx
    );
    return decisionId;
  }

  private async saveWinner(
    params: {
      competitionId: string;
      decisionId: string;
      winner: NativeDecisionWinner;
      scheduledAt: number;
      now: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    const values = { ...params, ...params.winner };
    await this.query(
      'saveWinner',
      `insert into ${COMPETITION_DECISION_WINNERS_TABLE}
      (decision_id, entry_id, competition_id, \`rank\`, final_rating, created_at)
      values (:decisionId, :entry_id, :competitionId, :rank, :final_rating, :now)`,
      values,
      ctx
    );
    await this.query(
      'saveWinner',
      `update ${COMPETITION_ENTRIES_TABLE} set status = 'WINNER', won_at = :scheduledAt, \`rank\` = :rank,
      decision_id = :decisionId where id = :entry_id and competition_id = :competitionId and status = 'ACTIVE'`,
      values,
      ctx
    );
    await this.query(
      'saveWinner',
      `delete from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id = :competitionId and entry_id = :entry_id`,
      values,
      ctx
    );
  }

  public async updateSchedule(
    competitionId: string,
    nextDecisionTime: number | null,
    now: number,
    ended: boolean,
    ctx: RequestContext
  ): Promise<void> {
    this.requireTransaction(ctx);
    if (ended)
      await this.query(
        'updateSchedule',
        `insert ignore into ${COMPETITION_LIFECYCLE_EVENTS_TABLE}
       (id, competition_id, wave_id, previous_lifecycle, lifecycle, actor_id, reason, created_at)
       select :id, id, wave_id, 'PUBLISHED', 'ENDED', null, 'SCHEDULE_COMPLETED', :now
       from ${COMPETITIONS_TABLE} where id = :competitionId and lifecycle = 'PUBLISHED'`,
        {
          id: stableUuid(competitionId, 'lifecycle:scheduled-end'),
          competitionId,
          now
        },
        ctx
      );
    await this.query(
      'updateSchedule',
      `update ${COMPETITIONS_TABLE}
      set decision_config = json_set(decision_config, '$.next_decision_time', :nextDecisionTime), updated_at = :now,
      lifecycle = if(:ended, 'ENDED', lifecycle), ended_at = if(:ended, :now, ended_at)
      where id = :competitionId and lifecycle = 'PUBLISHED'`,
      { competitionId, nextDecisionTime, now, ended },
      ctx
    );
    await mirrorNativeLegacySchedule(
      this.db,
      competitionId,
      nextDecisionTime,
      ctx
    );
  }

  public async listAwardsForDecisions(
    decisionIds: readonly string[],
    ctx: RequestContext
  ): Promise<NativeDecisionAward[]> {
    if (!decisionIds.length) return [];
    const rows = await this.query<{
      id: string;
      competition_id: string;
      decision_id: string;
      entry_id: string;
      award: NativeAward | string;
    }>(
      'listAwardsForDecisions',
      `select id, competition_id, decision_id, entry_id, award from ${COMPETITION_OUTCOME_AWARDS_TABLE}
      where decision_id in (:decisionIds) order by decision_id asc, entry_id asc, outcome_position asc`,
      { decisionIds },
      ctx
    );
    return rows.map(({ award, ...row }) => ({
      ...row,
      ...(typeof award === 'string'
        ? (JSON.parse(award) as NativeAward)
        : award)
    }));
  }

  public async enqueueEvent(
    params: Omit<
      NativeCompetitionEvent,
      'event_id' | 'event_version' | 'data'
    > & { key: string; data?: Record<string, unknown> },
    ctx: RequestContext
  ): Promise<string> {
    this.requireTransaction(ctx);
    const { key, ...values } = params;
    const id = stableUuid(params.competition_id, `event:${key}`);
    const event: NativeCompetitionEvent = {
      ...values,
      event_id: id,
      event_version: 1,
      data: params.data ?? {}
    };
    await this.query(
      'enqueueEvent',
      `insert ignore into ${COMPETITION_OUTBOX_TABLE}
      (id, competition_id, wave_id, semantic_key, event, created_at, next_attempt_at, attempts)
      values (:id, :competitionId, :waveId, :semanticKey, :event, :now, :now, 0)`,
      {
        id,
        competitionId: params.competition_id,
        waveId: params.wave_id,
        semanticKey: `${params.competition_id}:${key}`,
        event: JSON.stringify(event),
        now: params.occurred_at
      },
      ctx
    );
    return id;
  }

  public async claimOutbox(
    params: { now: number; limit: number; leaseMs?: number },
    ctx: RequestContext = {}
  ): Promise<NativeCompetitionOutboxRecord[]> {
    if (!ctx.connection)
      return this.executeNativeQueriesInTransaction((connection) =>
        this.claimOutbox(params, { ...ctx, connection })
      );
    const rows = await this.query<{
      id: string;
      event: NativeCompetitionEvent | string;
      attempts: number;
    }>(
      'claimOutbox',
      `select id, event, attempts from ${COMPETITION_OUTBOX_TABLE}
      where delivered_at is null and next_attempt_at <= :now and (lease_until is null or lease_until <= :now)
      order by created_at asc, id asc limit :limit for update skip locked`,
      { now: params.now, limit: Math.max(1, Math.min(100, params.limit)) },
      ctx
    );
    const result: NativeCompetitionOutboxRecord[] = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      await this.query(
        'claimOutbox',
        `update ${COMPETITION_OUTBOX_TABLE} set lease_token = :leaseToken, lease_until = :leaseUntil, attempts = attempts + 1 where id = :id`,
        {
          id: row.id,
          leaseToken,
          leaseUntil: params.now + (params.leaseMs ?? 60_000)
        },
        ctx
      );
      result.push({
        id: row.id,
        event:
          typeof row.event === 'string'
            ? (JSON.parse(row.event) as NativeCompetitionEvent)
            : row.event,
        lease_token: leaseToken,
        attempts: Number(row.attempts) + 1
      });
    }
    return result;
  }

  public async acknowledgeOutbox(
    id: string,
    leaseToken: string,
    now: number,
    ctx: RequestContext = {}
  ): Promise<void> {
    await this.query(
      'acknowledgeOutbox',
      `update ${COMPETITION_OUTBOX_TABLE} set delivered_at = :now, lease_until = null, lease_token = null
      where id = :id and lease_token = :leaseToken and delivered_at is null`,
      { id, leaseToken, now },
      ctx
    );
  }

  public async retryOutbox(
    id: string,
    leaseToken: string,
    now: number,
    ctx: RequestContext = {}
  ): Promise<void> {
    await this.query(
      'retryOutbox',
      `update ${COMPETITION_OUTBOX_TABLE} set next_attempt_at = :now + least(3600000, 1000 * pow(2, least(attempts, 12))), lease_until = null, lease_token = null
      where id = :id and lease_token = :leaseToken and delivered_at is null`,
      { id, leaseToken, now },
      ctx
    );
  }
}

export const nativeCompetitionRuntimeRepository =
  new NativeCompetitionRuntimeRepository(dbSupplier);
