import { INDEFINITE_COMPETITION_PAUSE_END } from './competition-phase';
import { competitionEntryVisibleSql } from '@/competitions/competition-entry-visibility';
import {
  anonymousCompetitionEntrySql,
  competitionAnonymityViewerId
} from '@/competitions/competition-anonymity';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  DROP_NFT_LINKS_TABLE,
  NFT_LINKS_TABLE
} from '@/constants';
import {
  CompetitionCapability,
  CompetitionDecisionStatus,
  CompetitionEntryStatus,
  CompetitionLifecycle,
  CompetitionType
} from '@/entities/ICompetition';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import type {
  CompetitionDecision,
  CompetitionConfigVersion,
  CompetitionDistributionItem,
  CompetitionEntry,
  CompetitionEntryVote,
  CompetitionLeaderboardEntry,
  CompetitionOutcome,
  CompetitionPage,
  CompetitionPageRequest,
  CompetitionPause,
  CompetitionRoutingRecord,
  CompetitionVoter
} from '@/competitions/competition.types';
import type { DefaultCompetitionRecord } from '@/competitions/default-competition';

type JsonValue = Record<string, unknown> | readonly unknown[];

export type CompetitionRecord = CompetitionRoutingRecord & {
  readonly presentation_config?: JsonValue | string | null;
  readonly type: CompetitionType;
  readonly lifecycle: CompetitionLifecycle;
  readonly title: string;
  readonly description: string | null;
  readonly participation_config: JsonValue | string;
  readonly voting_config: JsonValue | string;
  readonly decision_config: JsonValue | string;
  readonly winner_config: JsonValue | string;
  readonly outcome_config: JsonValue | string;
  readonly config_version: number | string;
  readonly participation_starts_at: number | string | null;
  readonly participation_ends_at: number | string | null;
  readonly voting_starts_at: number | string | null;
  readonly voting_ends_at: number | string | null;
  readonly created_at: number | string;
  readonly updated_at: number | string;
  readonly published_at: number | string | null;
  readonly ended_at: number | string | null;
  readonly cancelled_at: number | string | null;
  readonly archived_at: number | string | null;
};

type NativeEntryRecord = {
  readonly id: string;
  readonly wave_id: string;
  readonly competition_id: string;
  readonly drop_id: string;
  readonly submitter_id: string;
  readonly status: CompetitionEntryStatus;
  readonly config_version: number | string;
  readonly submitted_at: number | string;
  readonly rank: number | string | null;
  readonly won_at: number | string | null;
  readonly decision_id: string | null;
};

type NativeLeaderboardRecord = {
  readonly competition_id: string;
  readonly entry_id: string;
  readonly drop_id: string;
  readonly rating: number | string;
  readonly real_time_rating: number | string;
  readonly rank: number | string | null;
  readonly submitted_at: number | string;
};

type NativeDecisionRecord = {
  readonly id: string;
  readonly competition_id: string;
  readonly scheduled_at: number | string;
  readonly decided_at: number | string | null;
  readonly status: CompetitionDecisionStatus;
};

type NativeDecisionWinnerRecord = {
  readonly decision_id: string;
  readonly entry_id: string;
  readonly rank: number | string;
  readonly final_rating: number | string;
};

type NativeOutcomeRecord = {
  readonly id: string;
  readonly competition_id: string;
  readonly decision_id: string | null;
  readonly position: number | string;
  readonly legacy_index: number | string | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly description: string;
  readonly credit: string | null;
  readonly rep_category: string | null;
  readonly amount: number | string | null;
};

function dbOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

type DbNumber = number | string;
type NullableDbNumber = DbNumber | null;

function toNumber(value: DbNumber): number;
function toNumber(value: NullableDbNumber): number | null;
function toNumber(value: NullableDbNumber): number | null {
  return value === null ? null : Number(value);
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function directionSql(direction: CompetitionPageRequest['direction']): string {
  return direction === 'ASC' ? 'asc' : 'desc';
}

function pageFromRows<T>(
  rows: readonly T[],
  limit: number
): CompetitionPage<T> {
  const hasMore = rows.length > limit;
  return {
    data: hasMore ? rows.slice(0, limit) : rows,
    next_cursor: null,
    has_more: hasMore
  };
}

export class CompetitionRepository extends LazyDbAccessCompatibleService {
  /** Execution owns this row until its source writes commit. Discovery is advisory. */
  public async lockOriginalPrimary(waveId: string, ctx: RequestContext) {
    if (!ctx.connection)
      throw new Error('Execution fencing requires a transaction');
    const name = `${this.constructor.name}->lockOriginalPrimary`;
    ctx.timer?.start(name);
    try {
      return await this.db.oneOrNull<CompetitionRecord>(
        `select * from ${COMPETITIONS_TABLE} where legacy_wave_id=:waveId for update`,
        { waveId },
        dbOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(name);
    }
  }
  public constructor(db: () => SqlExecutor = dbSupplier) {
    super(db);
  }

  public async listDefaultCompetitionRecords(
    waveId: string,
    ctx: RequestContext
  ): Promise<DefaultCompetitionRecord[]> {
    return this.timed(ctx, 'listDefaultCompetitionRecords', () =>
      this.db.execute<DefaultCompetitionRecord>(
        `select id, type, lifecycle, published_at, ended_at, cancelled_at,
         participation_starts_at, participation_ends_at, voting_starts_at, voting_ends_at, decision_config
         from ${COMPETITIONS_TABLE} where wave_id = :waveId`,
        { waveId },
        dbOptions(ctx)
      )
    );
  }

  public async findCompetitionRecordById(
    id: string,
    ctx: RequestContext
  ): Promise<CompetitionRecord | null> {
    return this.timed(ctx, 'findCompetitionRecordById', () =>
      this.db.oneOrNull<CompetitionRecord>(
        `select * from ${COMPETITIONS_TABLE} where id = :id`,
        { id },
        dbOptions(ctx)
      )
    );
  }

  public async listCompetitionRecordsForWave(
    waveId: string,
    ctx: RequestContext
  ): Promise<CompetitionRecord[]> {
    return this.timed(ctx, 'listCompetitionRecordsForWave', () =>
      this.db.execute<CompetitionRecord>(
        `select * from ${COMPETITIONS_TABLE}
         where wave_id = :waveId
         order by created_at asc, id asc`,
        { waveId },
        dbOptions(ctx)
      )
    );
  }

  public async findCapabilities(
    competitionId: string,
    ctx: RequestContext
  ): Promise<CompetitionCapability[]> {
    const rows = await this.timed(ctx, 'findCapabilities', () =>
      this.db.execute<{ capability: CompetitionCapability }>(
        `select capability from ${COMPETITION_CAPABILITIES_TABLE}
         where competition_id = :competitionId order by capability asc`,
        { competitionId },
        dbOptions(ctx)
      )
    );
    return rows.map((row) => row.capability);
  }

  public async listConfigVersions(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionConfigVersion>> {
    const rows = await this.db.execute<{
      competition_id: string;
      version: number | string;
      config: Record<string, unknown> | string;
      created_at: number | string;
    }>(
      `select competition_id, version, config, created_at
       from ${COMPETITION_CONFIG_VERSIONS_TABLE}
       where competition_id = :competitionId
       order by version desc
       limit :offset, :rowLimit`,
      {
        competitionId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        competition_id: row.competition_id,
        version: toNumber(row.version),
        config: parseJson(row.config),
        created_at: toNumber(row.created_at)
      })),
      request.limit
    );
  }

  public parseCompetitionRecord(record: CompetitionRecord): CompetitionRecord {
    return {
      ...record,
      config_version: toNumber(record.config_version),
      participation_config: parseJson(record.participation_config),
      voting_config: parseJson(record.voting_config),
      decision_config: parseJson(record.decision_config),
      winner_config: parseJson(record.winner_config),
      outcome_config: parseJson(record.outcome_config),
      presentation_config: parseJson(record.presentation_config),
      participation_starts_at: toNumber(record.participation_starts_at),
      participation_ends_at: toNumber(record.participation_ends_at),
      voting_starts_at: toNumber(record.voting_starts_at),
      voting_ends_at: toNumber(record.voting_ends_at),
      created_at: toNumber(record.created_at),
      updated_at: toNumber(record.updated_at),
      published_at: toNumber(record.published_at),
      ended_at: toNumber(record.ended_at),
      cancelled_at: toNumber(record.cancelled_at),
      archived_at: toNumber(record.archived_at)
    };
  }

  public async findNativeEntriesByIds(
    competitionId: string,
    entryIds: readonly string[],
    ctx: RequestContext
  ): Promise<CompetitionEntry[]> {
    if (!entryIds.length) return [];
    const rows = await this.db.execute<NativeEntryRecord>(
      `select ce.* from ${COMPETITION_ENTRIES_TABLE} ce
       where ce.competition_id=:competitionId and ce.id in (:entryIds)
         and ${competitionEntryVisibleSql('ce')}`,
      { competitionId, entryIds },
      dbOptions(ctx)
    );
    const byId = new Map(rows.map((row) => [row.id, this.mapNativeEntry(row)]));
    return entryIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
  }

  public async listNativeEntries(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext,
    statuses?: readonly CompetitionEntryStatus[],
    submitterId?: string
  ): Promise<CompetitionPage<CompetitionEntry>> {
    const statusFilter = statuses?.length ? 'and ce.status in (:statuses)' : '';
    const submitterFilter = submitterId
      ? `and ce.submitter_id = :submitterId ${
          submitterId === competitionAnonymityViewerId(ctx)
            ? ''
            : `and not exists (select 1 from ${COMPETITIONS_TABLE} anonymity_competition
                where anonymity_competition.id=ce.competition_id
                  and ${anonymousCompetitionEntrySql('ce', 'anonymity_competition')})`
        }`
      : '';
    let order: string;
    if (request.sort === 'won_at') {
      order = `coalesce(ce.won_at, ce.submitted_at) ${directionSql(request.direction)}, ce.\`rank\` asc, ce.id ${directionSql(request.direction)}`;
    } else if (request.sort === 'rating') {
      order = `coalesce(leaderboard.rating, 0) ${directionSql(request.direction)},
               leaderboard.\`rank\` is null asc, leaderboard.\`rank\` asc,
               ce.id asc`;
    } else if (request.sort === 'rank') {
      order = `coalesce(ce.\`rank\`, leaderboard.\`rank\`) is null asc,
               coalesce(ce.\`rank\`, leaderboard.\`rank\`) ${directionSql(request.direction)},
               ce.id asc`;
    } else {
      order = `ce.submitted_at ${directionSql(request.direction)},
               ce.id ${directionSql(request.direction)}`;
    }
    const rows = await this.db.execute<NativeEntryRecord>(
      `select ce.*, coalesce(ce.\`rank\`, leaderboard.\`rank\`) as \`rank\` from ${COMPETITION_ENTRIES_TABLE} ce
       left join ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} leaderboard
         on leaderboard.competition_id = ce.competition_id
        and leaderboard.entry_id = ce.id
       where ce.competition_id = :competitionId and ${competitionEntryVisibleSql('ce')}
         ${statusFilter} ${submitterFilter}
       order by ${order}
       limit :offset, :rowLimit`,
      {
        competitionId,
        statuses,
        submitterId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => this.mapNativeEntry(row)),
      request.limit
    );
  }

  public async findNativeEntry(
    competitionId: string,
    entryId: string,
    ctx: RequestContext
  ): Promise<CompetitionEntry | null> {
    const row = await this.db.oneOrNull<NativeEntryRecord>(
      `select ce.*, coalesce(ce.\`rank\`, leaderboard.\`rank\`) as \`rank\`
       from ${COMPETITION_ENTRIES_TABLE} ce
       left join ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} leaderboard
         on leaderboard.competition_id = ce.competition_id and leaderboard.entry_id = ce.id
       where ce.competition_id = :competitionId and ce.id = :entryId
         and ${competitionEntryVisibleSql('ce')}`,
      { competitionId, entryId },
      dbOptions(ctx)
    );
    return row ? this.mapNativeEntry(row) : null;
  }

  public async listNativeLeaderboard(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>> {
    const priceRequested =
      request.sort === 'price' ||
      request.min_price != null ||
      request.max_price != null;
    const priceSelect = priceRequested
      ? `left join (select dnl.drop_id,max(nl.price) as price from ${DROP_NFT_LINKS_TABLE} dnl
          join ${NFT_LINKS_TABLE} nl on nl.canonical_id=dnl.canonical_id
          where nl.price is not null and (:priceCurrency is null or upper(nl.price_currency)=upper(:priceCurrency))
          group by dnl.drop_id) prices on prices.drop_id=e.drop_id`
      : '';
    const orderColumns: Readonly<Record<string, string>> = {
      submitted_at: 'lb.submitted_at',
      real_time_rating: 'lb.real_time_rating',
      trend: '(lb.real_time_rating - lb.rating)',
      rating: 'lb.rating',
      price: 'prices.price'
    };
    const orderColumn = orderColumns[request.sort ?? 'rating'] ?? 'lb.rating';
    const order =
      request.sort === 'price'
        ? `prices.price is null asc,prices.price ${directionSql(request.direction)},lb.submitted_at desc,lb.drop_id desc`
        : `${orderColumn} ${directionSql(request.direction)},lb.\`rank\` is null asc,lb.\`rank\` asc,case when c.legacy_wave_id is null then lb.entry_id else lb.drop_id end asc`;
    const rows = await this.db.execute<NativeLeaderboardRecord>(
      `select lb.* from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb
       join ${COMPETITION_ENTRIES_TABLE} e on e.id=lb.entry_id and e.competition_id=lb.competition_id
       join ${COMPETITIONS_TABLE} c on c.id=lb.competition_id
       ${priceSelect}
       where lb.competition_id = :competitionId and ${competitionEntryVisibleSql('e')}
       ${priceRequested ? 'and (:minPrice is null or prices.price>=:minPrice) and (:maxPrice is null or prices.price<=:maxPrice)' : ''}
       order by ${order}
       limit :offset, :rowLimit`,
      {
        competitionId,
        priceCurrency: request.price_currency ?? null,
        minPrice: request.min_price ?? null,
        maxPrice: request.max_price ?? null,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        competition_id: row.competition_id,
        entry_id: row.entry_id,
        drop_id: row.drop_id,
        rating: toNumber(row.rating),
        real_time_rating: toNumber(row.real_time_rating),
        rank: toNumber(row.rank),
        submitted_at: toNumber(row.submitted_at)
      })),
      request.limit
    );
  }

  public async listNativeVoters(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext,
    entryId?: string
  ): Promise<CompetitionPage<CompetitionVoter>> {
    const entryFilter = entryId ? 'and v.entry_id = :entryId' : '';
    const rows = await this.db.execute<{
      voter_profile_id: string;
      votes: number | string;
      credit_spent: number | string;
    }>(
      `select v.voter_profile_id,
              sum(${entryId ? "case when e.status = 'WINNER' then coalesce(wv.value, v.value) else v.value end" : 'v.value'}) as votes,
              sum(v.credit_spent) as credit_spent
       from ${COMPETITION_VOTES_TABLE} v
       join ${COMPETITION_ENTRIES_TABLE} e on e.id = v.entry_id and e.competition_id = v.competition_id
       left join ${COMPETITION_WINNER_VOTES_TABLE} wv on wv.decision_id = e.decision_id and wv.entry_id = e.id
         and wv.competition_id = e.competition_id and wv.voter_profile_id = v.voter_profile_id
       where v.competition_id = :competitionId and ${competitionEntryVisibleSql('e')} ${entryFilter}
       group by v.voter_profile_id
       order by votes ${directionSql(request.direction)}, v.voter_profile_id asc
       limit :offset, :rowLimit`,
      {
        competitionId,
        entryId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        profile_id: row.voter_profile_id,
        votes: toNumber(row.votes),
        credit_spent: toNumber(row.credit_spent)
      })),
      request.limit
    );
  }

  public async listNativeEntryVotes(
    competitionId: string,
    entryId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionEntryVote>> {
    const rows = await this.db.execute<{
      id: string;
      entry_id: string;
      voter_profile_id: string;
      value: number | string;
      credit_spent: number | string;
      created_at: number | string;
      updated_at: number | string;
    }>(
      `select v.id, v.entry_id, v.voter_profile_id, v.credit_spent, v.created_at, v.updated_at,
              case when e.status = 'WINNER' then coalesce(wv.value, v.value) else v.value end as value
       from ${COMPETITION_VOTES_TABLE} v
       join ${COMPETITION_ENTRIES_TABLE} e on e.id = v.entry_id and e.competition_id = v.competition_id
       left join ${COMPETITION_WINNER_VOTES_TABLE} wv on wv.decision_id = e.decision_id and wv.entry_id = e.id
         and wv.competition_id = e.competition_id and wv.voter_profile_id = v.voter_profile_id
       where v.competition_id = :competitionId and v.entry_id = :entryId
         and ${competitionEntryVisibleSql('e')}
       order by v.updated_at ${directionSql(request.direction)}, v.id asc
       limit :offset, :rowLimit`,
      {
        competitionId,
        entryId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        id: row.id,
        entry_id: row.entry_id,
        voter_profile_id: row.voter_profile_id,
        value: toNumber(row.value),
        credit_spent: toNumber(row.credit_spent),
        created_at: toNumber(row.created_at),
        updated_at: toNumber(row.updated_at)
      })),
      request.limit
    );
  }

  public async listNativeDecisions(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionDecision>> {
    const decisions = await this.db.execute<NativeDecisionRecord>(
      `select * from ${COMPETITION_DECISIONS_TABLE}
       where competition_id = :competitionId
       order by scheduled_at ${directionSql(request.direction)}, id asc
       limit :offset, :rowLimit`,
      {
        competitionId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    const visible = decisions.slice(0, request.limit);
    const winners = await this.findNativeDecisionWinners(
      visible.map((decision) => decision.id),
      ctx
    );
    return {
      data: visible.map((decision) => ({
        id: decision.id,
        competition_id: decision.competition_id,
        scheduled_at: toNumber(decision.scheduled_at),
        decided_at: toNumber(decision.decided_at),
        status: decision.status,
        winners: winners
          .filter((winner) => winner.decision_id === decision.id)
          .map((winner) => ({
            entry_id: winner.entry_id,
            rank: toNumber(winner.rank),
            final_rating: toNumber(winner.final_rating)
          }))
      })),
      next_cursor: null,
      has_more: decisions.length > request.limit
    };
  }

  public async listNativeOutcomes(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionOutcome>> {
    const rows = await this.db.execute<NativeOutcomeRecord>(
      `select * from ${COMPETITION_OUTCOMES_TABLE}
       where competition_id = :competitionId
       order by position ${directionSql(request.direction)}, id asc
       limit :offset, :rowLimit`,
      {
        competitionId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => this.mapNativeOutcome(row)),
      request.limit
    );
  }

  public async listNativeDistribution(
    competitionId: string,
    outcomeId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionDistributionItem>> {
    const rows = await this.db.execute<{
      id: string;
      outcome_id: string;
      position: number | string;
      amount: number | string | null;
      description: string | null;
    }>(
      `select * from ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE}
       where competition_id = :competitionId and outcome_id = :outcomeId
       order by position ${directionSql(request.direction)}, id asc
       limit :offset, :rowLimit`,
      {
        competitionId,
        outcomeId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        id: row.id,
        outcome_id: row.outcome_id,
        position: toNumber(row.position),
        amount: toNumber(row.amount),
        description: row.description
      })),
      request.limit
    );
  }

  public async listNativePauses(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionPause>> {
    const rows = await this.db.execute<{
      id: string;
      competition_id: string;
      start_time: number | string;
      end_time: number | string | null;
      reason: string | null;
      legacy_source_id: number | string | null;
    }>(
      `select * from ${COMPETITION_PAUSES_TABLE}
       where competition_id = :competitionId
       order by start_time ${directionSql(request.direction)}, id asc
       limit :offset, :rowLimit`,
      {
        competitionId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        id: row.id,
        competition_id: row.competition_id,
        start_time: toNumber(row.start_time),
        end_time:
          row.legacy_source_id != null &&
          Number(row.end_time) === INDEFINITE_COMPETITION_PAUSE_END
            ? null
            : toNumber(row.end_time),
        reason: row.reason
      })),
      request.limit
    );
  }

  private mapNativeEntry(row: NativeEntryRecord): CompetitionEntry {
    return {
      id: row.id,
      wave_id: row.wave_id,
      competition_id: row.competition_id,
      drop_id: row.drop_id,
      submitter_id: row.submitter_id,
      status: row.status,
      config_version: toNumber(row.config_version),
      submitted_at: toNumber(row.submitted_at),
      rank: toNumber(row.rank),
      won_at: toNumber(row.won_at),
      decision_id: row.decision_id
    };
  }

  private mapNativeOutcome(row: NativeOutcomeRecord): CompetitionOutcome {
    return {
      id: row.id,
      competition_id: row.competition_id,
      decision_id: row.decision_id,
      position: toNumber(row.position),
      legacy_index: toNumber(row.legacy_index),
      type: row.type,
      subtype: row.subtype,
      description: row.description,
      credit: row.credit,
      rep_category: row.rep_category,
      amount: toNumber(row.amount)
    };
  }

  private async findNativeDecisionWinners(
    decisionIds: readonly string[],
    ctx: RequestContext
  ): Promise<NativeDecisionWinnerRecord[]> {
    if (!decisionIds.length) return [];
    return this.db.execute<NativeDecisionWinnerRecord>(
      `select winner.* from ${COMPETITION_DECISION_WINNERS_TABLE} winner
       left join ${COMPETITION_ENTRIES_TABLE} e on e.id=winner.entry_id and e.competition_id=winner.competition_id
       where winner.decision_id in (:decisionIds)
         and (winner.legacy_drop_id is not null or ${competitionEntryVisibleSql('e')})
       order by winner.\`rank\` asc, winner.entry_id asc`,
      { decisionIds },
      dbOptions(ctx)
    );
  }

  private async timed<T>(
    ctx: RequestContext,
    method: string,
    action: () => Promise<T>
  ): Promise<T> {
    const timerName = `${this.constructor.name}->${method}`;
    ctx.timer?.start(timerName);
    try {
      return await action();
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const competitionRepository = new CompetitionRepository();
