import { randomUUID } from 'node:crypto';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PARITY_OBSERVATIONS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  CompetitionCapability,
  CompetitionDecisionStatus,
  CompetitionEntryStatus,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionParityCategory,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import { DropType } from '@/entities/IDrop';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { env } from '@/env';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import {
  legacyCompetitionDecisionId,
  legacyCompetitionDistributionItemId,
  legacyCompetitionEntryId,
  legacyCompetitionId,
  legacyCompetitionOutcomeId,
  legacyCompetitionPauseId,
  stableUuid
} from '@/competitions/competition-id';
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
import { collectCompetitionPages } from '@/competitions/competition-page';

type JsonValue = Record<string, unknown> | readonly unknown[];

export type CompetitionRecord = CompetitionRoutingRecord & {
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

type LegacyWaveRecord = Omit<
  WaveEntity,
  | 'serial_no'
  | 'participation_required_metadata'
  | 'participation_required_media'
  | 'decisions_strategy'
> & {
  readonly serial_no: number | string | null;
  readonly participation_required_metadata:
    | WaveEntity['participation_required_metadata']
    | JsonValue
    | string;
  readonly participation_required_media:
    | WaveEntity['participation_required_media']
    | JsonValue
    | string;
  readonly decisions_strategy:
    | WaveEntity['decisions_strategy']
    | JsonValue
    | string
    | null;
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

function waveTypeToCompetitionType(type: WaveType): CompetitionType {
  if (type === WaveType.RANK) return CompetitionType.RANK;
  if (type === WaveType.APPROVE) return CompetitionType.APPROVE;
  throw new Error(`Chat wave cannot have a legacy competition mapping`);
}

function legacyLifecycle(
  wave: LegacyWaveRecord | WaveEntity
): CompetitionLifecycle {
  const now = Date.now();
  const participationEnd = toNumber(wave.participation_period_end);
  const votingEnd = toNumber(wave.voting_period_end);
  const relevantEnds = [participationEnd, votingEnd].filter(
    (value): value is number => value !== null
  );
  const hasEnded =
    relevantEnds.length > 0 &&
    relevantEnds.every((value) => value <= now) &&
    wave.next_decision_time === null;
  return hasEnded ? CompetitionLifecycle.ENDED : CompetitionLifecycle.PUBLISHED;
}

function legacyEndedAt(wave: LegacyWaveRecord | WaveEntity): number | null {
  if (legacyLifecycle(wave) !== CompetitionLifecycle.ENDED) return null;
  const endpoints = [
    toNumber(wave.participation_period_end),
    toNumber(wave.voting_period_end)
  ].filter((value): value is number => value !== null);
  return endpoints.length ? Math.max(...endpoints) : null;
}

function legacyConfig(
  wave: LegacyWaveRecord | WaveEntity,
  creditNfts: unknown[]
) {
  const participation = {
    group_id: wave.participation_group_id,
    signature_required: Boolean(wave.participation_signature_required),
    max_entries_per_participant: toNumber(
      wave.participation_max_applications_per_participant
    ),
    required_metadata: parseJson<readonly unknown[]>(
      wave.participation_required_metadata as string | readonly unknown[]
    ),
    required_media: parseJson<readonly unknown[]>(
      wave.participation_required_media as string | readonly unknown[]
    ),
    submission_type: wave.submission_type,
    identity_submission_strategy: wave.identity_submission_strategy,
    identity_submission_duplicates: wave.identity_submission_duplicates,
    starts_at: toNumber(wave.participation_period_start),
    ends_at: toNumber(wave.participation_period_end),
    terms: wave.participation_terms
  };
  const voting = {
    group_id: wave.voting_group_id,
    credit_type: wave.voting_credit_type,
    credit_scope: wave.voting_credit_scope,
    credit_category: wave.voting_credit_category,
    credit_creditor: wave.voting_credit_creditor,
    credit_nfts: creditNfts,
    signature_required: Boolean(wave.voting_signature_required),
    starts_at: toNumber(wave.voting_period_start),
    ends_at: toNumber(wave.voting_period_end),
    max_votes_per_identity_to_entry: toNumber(
      wave.max_votes_per_identity_to_drop
    ),
    forbid_negative_votes: Boolean(wave.forbid_negative_votes)
  };
  const decisions = {
    strategy:
      wave.decisions_strategy === null
        ? null
        : (parseJson(wave.decisions_strategy) as unknown as Record<
            string,
            unknown
          >),
    next_decision_time: toNumber(wave.next_decision_time),
    winning_min_threshold: toNumber(wave.winning_min_threshold),
    winning_max_threshold: toNumber(wave.winning_max_threshold),
    winning_threshold_min_duration_ms: Number(
      wave.winning_threshold_min_duration_ms
    ),
    max_winners: toNumber(wave.max_winners),
    time_lock_ms: toNumber(wave.time_lock_ms)
  };
  const winners = {
    max_winners: decisions.max_winners,
    winning_min_threshold: decisions.winning_min_threshold,
    winning_max_threshold: decisions.winning_max_threshold,
    winning_threshold_min_duration_ms:
      decisions.winning_threshold_min_duration_ms
  };
  return { participation, voting, decisions, winners };
}

const LEGACY_CAPABILITY_ENV: ReadonlyArray<{
  readonly envName: string;
  readonly capability: CompetitionCapability;
}> = [
  {
    envName: 'MAIN_STAGE_WAVE_ID',
    capability: CompetitionCapability.MAIN_STAGE
  },
  { envName: 'CURATION_WAVE_ID', capability: CompetitionCapability.CURATION },
  { envName: 'QUORUM_WAVE_ID', capability: CompetitionCapability.QUORUM },
  {
    envName: 'ANNOUNCEMENTS_WAVE_ID',
    capability: CompetitionCapability.ANNOUNCEMENTS
  }
];

export class CompetitionRepository extends LazyDbAccessCompatibleService {
  public constructor(db: () => SqlExecutor = dbSupplier) {
    super(db);
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

  public async ensureLegacyMappingForWave(
    wave: LegacyWaveRecord | WaveEntity,
    ctx: RequestContext
  ): Promise<boolean> {
    if (wave.type === WaveType.CHAT) return false;
    const competitionId = legacyCompetitionId(wave.id);
    const creditNfts = await this.getLegacyCreditNfts(wave.id, ctx);
    const config = legacyConfig(wave, creditNfts);
    const versionConfig = {
      title: wave.name,
      type: waveTypeToCompetitionType(wave.type),
      ...config
    };
    const now = Date.now();
    const lifecycle = legacyLifecycle(wave);
    const result = await this.db.execute(
      `insert ignore into ${COMPETITIONS_TABLE}
       (id, wave_id, legacy_wave_id, storage_mode, execution_mode, type,
        lifecycle, title, description, participation_config, voting_config,
        decision_config, winner_config, outcome_config, config_version,
        participation_starts_at, participation_ends_at, voting_starts_at,
        voting_ends_at, created_at, updated_at, published_at, ended_at,
        cancelled_at, archived_at)
       values
       (:id, :waveId, :waveId, :storageMode, :executionMode, :type,
        :lifecycle, :title, null, :participation, :voting, :decisions,
        :winners, :outcomes, 1, :participationStart, :participationEnd,
        :votingStart, :votingEnd, :createdAt, :updatedAt, :publishedAt,
        :endedAt, null, null)`,
      {
        id: competitionId,
        waveId: wave.id,
        storageMode: CompetitionStorageMode.LEGACY_ADAPTER,
        executionMode: CompetitionExecutionMode.ACTIVE,
        type: waveTypeToCompetitionType(wave.type),
        lifecycle,
        title: wave.name,
        participation: JSON.stringify(config.participation),
        voting: JSON.stringify(config.voting),
        decisions: JSON.stringify(config.decisions),
        winners: JSON.stringify(config.winners),
        outcomes: JSON.stringify([]),
        participationStart: config.participation.starts_at,
        participationEnd: config.participation.ends_at,
        votingStart: config.voting.starts_at,
        votingEnd: config.voting.ends_at,
        createdAt: Number(wave.created_at),
        updatedAt: toNumber(wave.updated_at) ?? Number(wave.created_at),
        publishedAt: Number(wave.created_at),
        endedAt:
          lifecycle === CompetitionLifecycle.ENDED ? legacyEndedAt(wave) : null
      },
      dbOptions(ctx)
    );
    const inserted = this.db.getAffectedRows(result) === 1;
    if (inserted) {
      await this.db.execute(
        `insert into ${COMPETITION_CONFIG_VERSIONS_TABLE}
         (competition_id, version, config, created_by, created_at)
         values (:competitionId, 1, :config, :createdBy, :createdAt)`,
        {
          competitionId,
          config: JSON.stringify(versionConfig),
          createdBy: wave.created_by,
          createdAt: Number(wave.created_at)
        },
        dbOptions(ctx)
      );
    } else {
      const existing = await this.db.oneOrNull<{
        config_version: number | string;
      }>(
        `select config_version from ${COMPETITIONS_TABLE}
         where id = :competitionId for update`,
        { competitionId },
        dbOptions(ctx)
      );
      if (!existing) {
        throw new Error(`Legacy competition mapping ${competitionId} missing`);
      }
      const configVersion = toNumber(existing.config_version) + 1;
      await this.db.execute(
        `update ${COMPETITIONS_TABLE}
         set type = :type, lifecycle = :lifecycle, title = :title,
             participation_config = :participation,
             voting_config = :voting, decision_config = :decisions,
             winner_config = :winners, config_version = :configVersion,
             participation_starts_at = :participationStart,
             participation_ends_at = :participationEnd,
             voting_starts_at = :votingStart, voting_ends_at = :votingEnd,
             updated_at = :updatedAt, ended_at = :endedAt
         where id = :competitionId and legacy_wave_id = :waveId`,
        {
          competitionId,
          waveId: wave.id,
          type: waveTypeToCompetitionType(wave.type),
          lifecycle,
          title: wave.name,
          participation: JSON.stringify(config.participation),
          voting: JSON.stringify(config.voting),
          decisions: JSON.stringify(config.decisions),
          winners: JSON.stringify(config.winners),
          configVersion,
          participationStart: config.participation.starts_at,
          participationEnd: config.participation.ends_at,
          votingStart: config.voting.starts_at,
          votingEnd: config.voting.ends_at,
          updatedAt: toNumber(wave.updated_at) ?? now,
          endedAt:
            lifecycle === CompetitionLifecycle.ENDED
              ? legacyEndedAt(wave)
              : null
        },
        dbOptions(ctx)
      );
      await this.db.execute(
        `insert into ${COMPETITION_CONFIG_VERSIONS_TABLE}
         (competition_id, version, config, created_by, created_at)
         values (:competitionId, :configVersion, :config, :createdBy,
          :createdAt)`,
        {
          competitionId,
          configVersion,
          config: JSON.stringify(versionConfig),
          createdBy: wave.created_by,
          createdAt: toNumber(wave.updated_at) ?? now
        },
        dbOptions(ctx)
      );
    }
    await this.ensureLegacyCapabilities(wave.id, competitionId, ctx);
    return inserted;
  }

  public async backfillLegacyMappings(
    ctx: RequestContext,
    batchSize = 250
  ): Promise<number> {
    let inserted = 0;
    while (true) {
      const rows = await this.db.execute<LegacyWaveRecord>(
        `select w.* from ${WAVES_TABLE} w
         left join ${COMPETITIONS_TABLE} c on c.legacy_wave_id = w.id
         where w.type in (:types) and c.id is null
         order by w.serial_no asc limit :batchSize`,
        {
          types: [WaveType.RANK, WaveType.APPROVE],
          batchSize
        },
        dbOptions(ctx)
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (await this.ensureLegacyMappingForWave(row, ctx)) inserted++;
      }
      if (rows.length < batchSize) break;
    }
    await this.ensureConfiguredLegacyCapabilities(ctx);
    return inserted;
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

  public async listNativeEntries(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext,
    statuses?: readonly CompetitionEntryStatus[],
    submitterId?: string
  ): Promise<CompetitionPage<CompetitionEntry>> {
    const statusFilter = statuses?.length ? 'and ce.status in (:statuses)' : '';
    const submitterFilter = submitterId
      ? 'and ce.submitter_id = :submitterId'
      : '';
    let order: string;
    if (request.sort === 'rating') {
      order = `coalesce(leaderboard.rating, 0) ${directionSql(request.direction)},
               coalesce(leaderboard.submitted_at, ce.submitted_at) asc,
               ce.id asc`;
    } else if (request.sort === 'rank') {
      order = `ce.rank is null asc, ce.rank ${directionSql(request.direction)},
               ce.id asc`;
    } else {
      order = `ce.submitted_at ${directionSql(request.direction)},
               ce.id ${directionSql(request.direction)}`;
    }
    const rows = await this.db.execute<NativeEntryRecord>(
      `select ce.* from ${COMPETITION_ENTRIES_TABLE} ce
       left join ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} leaderboard
         on leaderboard.competition_id = ce.competition_id
        and leaderboard.entry_id = ce.id
       where ce.competition_id = :competitionId
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
      `select * from ${COMPETITION_ENTRIES_TABLE}
       where competition_id = :competitionId and id = :entryId`,
      { competitionId, entryId },
      dbOptions(ctx)
    );
    return row ? this.mapNativeEntry(row) : null;
  }

  public async listLegacyEntries(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    ctx: RequestContext,
    statuses?: readonly CompetitionEntryStatus[],
    submitterId?: string
  ): Promise<CompetitionPage<CompetitionEntry>> {
    const dropTypes = this.dropTypesForStatuses(statuses);
    if (!dropTypes.length) return pageFromRows([], request.limit);
    const authorFilter = submitterId ? 'and d.author_id = :submitterId' : '';
    let order: string;
    if (request.sort === 'rating') {
      order = `rating ${directionSql(request.direction)}, tie_time asc, id asc`;
    } else if (request.sort === 'rank') {
      order = `coalesce(ranking, competition_rank) is null asc,
               coalesce(ranking, competition_rank) ${directionSql(request.direction)},
               id asc`;
    } else {
      order = `created_at ${directionSql(request.direction)},
               id ${directionSql(request.direction)}`;
    }
    const rows = await this.db.execute<{
      id: string;
      wave_id: string;
      author_id: string;
      created_at: number | string;
      drop_type: DropType;
      config_version: number | string;
      competition_rank: number | string | null;
      decision_time: number | string | null;
      ranking: number | string | null;
    }>(
      `with entry_source as (
         select d.id, d.wave_id, d.author_id, d.created_at, d.drop_type,
                coalesce((
                  select max(ccv.version)
                  from ${COMPETITION_CONFIG_VERSIONS_TABLE} ccv
                  where ccv.competition_id = :competitionId
                    and ccv.created_at <= d.created_at
                ), 1) as config_version,
                cast(ifnull(dr.vote, 0) as signed) as rating,
                cast(ifnull(dr.last_increased, d.created_at) as signed) as tie_time,
                wdw.decision_time, wdw.ranking
         from ${DROPS_TABLE} d
         left join ${DROP_RANK_TABLE} dr on dr.drop_id = d.id
         left join (
           select wave_id, drop_id, decision_time, ranking
           from (
             select wave_id, drop_id, decision_time, ranking,
                    row_number() over (
                      partition by wave_id, drop_id
                      order by decision_time desc, ranking asc
                          ) as winner_row_number
             from ${WAVES_DECISION_WINNER_DROPS_TABLE}
           ) latest_winner
                 where winner_row_number = 1
         ) wdw
           on wdw.drop_id = d.id and wdw.wave_id = d.wave_id
         where d.wave_id = :waveId and d.drop_type in (:dropTypes) ${authorFilter}
       ), ranked as (
         select entry_source.*,
                rank() over (order by rating desc, tie_time asc) as competition_rank
         from entry_source
       )
       select id, wave_id, author_id, created_at, drop_type, config_version,
              competition_rank, decision_time, ranking
       from ranked
       order by ${order}
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        competitionId: record.id,
        dropTypes,
        submitterId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    const entries = rows.map((row) =>
      this.mapLegacyEntry(record, { ...row, rank: row.competition_rank })
    );
    return pageFromRows(entries, request.limit);
  }

  public async findLegacyEntry(
    record: CompetitionRoutingRecord,
    entryId: string,
    ctx: RequestContext
  ): Promise<CompetitionEntry | null> {
    const dropId = await this.findLegacyDropIdByEntry(record, entryId, ctx);
    if (!dropId) return null;
    const row = await this.db.oneOrNull<{
      id: string;
      wave_id: string;
      author_id: string;
      created_at: number | string;
      drop_type: DropType;
      config_version: number | string;
      competition_rank: number | string | null;
      decision_time: number | string | null;
      ranking: number | string | null;
    }>(
      `with entry_source as (
         select d.id, d.wave_id, d.author_id, d.created_at, d.drop_type,
                coalesce((
                  select max(ccv.version)
                  from ${COMPETITION_CONFIG_VERSIONS_TABLE} ccv
                  where ccv.competition_id = :competitionId
                    and ccv.created_at <= d.created_at
                ), 1) as config_version,
                cast(ifnull(dr.vote, 0) as signed) as rating,
                cast(ifnull(dr.last_increased, d.created_at) as signed) as tie_time,
                wdw.decision_time, wdw.ranking
         from ${DROPS_TABLE} d
         left join ${DROP_RANK_TABLE} dr on dr.drop_id = d.id
         left join (
           select wave_id, drop_id, decision_time, ranking
           from (
             select wave_id, drop_id, decision_time, ranking,
                    row_number() over (
                      partition by wave_id, drop_id
                      order by decision_time desc, ranking asc
                    ) as winner_row_number
             from ${WAVES_DECISION_WINNER_DROPS_TABLE}
           ) latest_winner
           where winner_row_number = 1
         ) wdw on wdw.drop_id = d.id and wdw.wave_id = d.wave_id
         where d.wave_id = :waveId
           and d.drop_type in (:dropTypes)
       ), ranked as (
         select entry_source.*,
                rank() over (order by rating desc, tie_time asc) as competition_rank
         from entry_source
       )
       select id, wave_id, author_id, created_at, drop_type, config_version,
              competition_rank, decision_time, ranking
       from ranked where id = :dropId`,
      {
        waveId: record.wave_id,
        competitionId: record.id,
        dropId,
        dropTypes: [DropType.PARTICIPATORY, DropType.WINNER]
      },
      dbOptions(ctx)
    );
    return row
      ? this.mapLegacyEntry(record, { ...row, rank: row.competition_rank })
      : null;
  }

  public async listNativeLeaderboard(
    competitionId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>> {
    const rows = await this.db.execute<NativeLeaderboardRecord>(
      `select * from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE}
       where competition_id = :competitionId
       order by rating ${directionSql(request.direction)},
                submitted_at asc, entry_id asc
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

  public async listLegacyLeaderboard(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>> {
    const rows = await this.db.execute<{
      drop_id: string;
      submitted_at: number | string;
      rating: number | string;
      real_time_rating: number | string;
      competition_rank: number | string | null;
    }>(
      `with leaderboard_source as (
         select d.id as drop_id,
                d.created_at as submitted_at,
                cast(if(w.time_lock_ms is not null and w.time_lock_ms > 0,
                  ifnull(wle.vote, 0), ifnull(dr.vote, 0)) as signed) as rating,
                cast(ifnull(dr.vote, 0) as signed) as real_time_rating,
                cast(if(w.time_lock_ms is not null and w.time_lock_ms > 0,
                  ifnull(wle.timestamp, d.created_at),
                  ifnull(dr.last_increased, d.created_at)) as signed) as tie_time
         from ${DROPS_TABLE} d
         join ${WAVES_TABLE} w on w.id = d.wave_id
         left join ${DROP_RANK_TABLE} dr on dr.drop_id = d.id
         left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} wle
           on wle.drop_id = d.id and wle.wave_id = d.wave_id
         where d.wave_id = :waveId
           and d.drop_type = :dropType
       ), ranked as (
         select leaderboard_source.*,
                rank() over (order by rating desc, tie_time asc) as competition_rank
         from leaderboard_source
       )
       select drop_id, submitted_at, rating, real_time_rating, competition_rank
       from ranked
       order by rating ${directionSql(request.direction)},
                tie_time asc, drop_id asc
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        dropType: DropType.PARTICIPATORY,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        competition_id: record.id,
        entry_id: legacyCompetitionEntryId(record.id, row.drop_id),
        drop_id: row.drop_id,
        rating: toNumber(row.rating),
        real_time_rating: toNumber(row.real_time_rating),
        rank: toNumber(row.competition_rank),
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
    const entryFilter = entryId ? 'and entry_id = :entryId' : '';
    const rows = await this.db.execute<{
      voter_profile_id: string;
      votes: number | string;
      credit_spent: number | string;
    }>(
      `select voter_profile_id, sum(value) as votes,
              sum(credit_spent) as credit_spent
       from ${COMPETITION_VOTES_TABLE}
       where competition_id = :competitionId ${entryFilter}
       group by voter_profile_id
       order by votes ${directionSql(request.direction)}, voter_profile_id asc
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

  public async listLegacyVoters(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    ctx: RequestContext,
    entryId?: string
  ): Promise<CompetitionPage<CompetitionVoter>> {
    const dropId = entryId
      ? await this.findLegacyDropIdByEntry(record, entryId, ctx)
      : null;
    if (entryId && !dropId) return pageFromRows([], request.limit);
    const dropFilter = dropId ? 'and dvs.drop_id = :dropId' : '';
    const rows = await this.db.execute<{
      voter_id: string;
      votes: number | string;
      credit_spent: number | string;
    }>(
      `select dvs.voter_id, sum(dvs.votes) as votes,
              coalesce(sum(dvcs.credit_spent), 0) as credit_spent
       from ${DROP_VOTER_STATE_TABLE} dvs
       left join (
         select wave_id, drop_id, voter_id, sum(credit_spent) as credit_spent
         from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE}
         group by wave_id, drop_id, voter_id
       ) dvcs
         on dvcs.wave_id = dvs.wave_id and dvcs.drop_id = dvs.drop_id
        and dvcs.voter_id = dvs.voter_id
       where dvs.wave_id = :waveId ${dropFilter}
       group by dvs.voter_id
       order by votes ${directionSql(request.direction)}, dvs.voter_id asc
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        dropId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        profile_id: row.voter_id,
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
      `select * from ${COMPETITION_VOTES_TABLE}
       where competition_id = :competitionId and entry_id = :entryId
       order by updated_at ${directionSql(request.direction)}, id asc
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

  public async listLegacyEntryVotes(
    record: CompetitionRoutingRecord,
    entryId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionEntryVote>> {
    const dropId = await this.findLegacyDropIdByEntry(record, entryId, ctx);
    if (!dropId) return pageFromRows([], request.limit);
    const rows = await this.db.execute<{
      voter_id: string;
      votes: number | string;
      credit_spent: number | string;
      created_at: number | string | null;
    }>(
      `select dvs.voter_id, dvs.votes,
              coalesce(sum(dvcs.credit_spent), 0) as credit_spent,
              min(dvcs.created_at) as created_at
       from ${DROP_VOTER_STATE_TABLE} dvs
       left join (
         select wave_id, drop_id, voter_id, sum(credit_spent) as credit_spent,
                min(created_at) as created_at
         from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE}
         group by wave_id, drop_id, voter_id
       ) dvcs
         on dvcs.wave_id = dvs.wave_id and dvcs.drop_id = dvs.drop_id
        and dvcs.voter_id = dvs.voter_id
       where dvs.wave_id = :waveId and dvs.drop_id = :dropId
       group by dvs.voter_id, dvs.votes
       order by dvs.votes ${directionSql(request.direction)}, dvs.voter_id asc
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        dropId,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => {
        const observedAt = toNumber(row.created_at) ?? 0;
        return {
          id: stableUuid(record.id, `vote:${dropId}:${row.voter_id}`),
          entry_id: entryId,
          voter_profile_id: row.voter_id,
          value: toNumber(row.votes),
          credit_spent: toNumber(row.credit_spent),
          created_at: observedAt,
          updated_at: observedAt
        };
      }),
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

  public async listLegacyDecisions(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionDecision>> {
    const rows = await this.db.execute<{
      decision_time: number | string;
      drop_id: string | null;
      ranking: number | string | null;
      final_vote: number | string | null;
    }>(
      `select wd.decision_time, wdw.drop_id, wdw.ranking, wdw.final_vote
       from ${WAVES_DECISIONS_TABLE} wd
       left join ${WAVES_DECISION_WINNER_DROPS_TABLE} wdw
         on wdw.wave_id = wd.wave_id and wdw.decision_time = wd.decision_time
       where wd.wave_id = :waveId
       order by wd.decision_time ${directionSql(request.direction)},
                wdw.ranking asc, wdw.drop_id asc`,
      { waveId: record.wave_id },
      dbOptions(ctx)
    );
    const grouped = new Map<
      number,
      Omit<CompetitionDecision, 'winners'> & {
        winners: CompetitionDecision['winners'][number][];
      }
    >();
    for (const row of rows) {
      const decisionTime = toNumber(row.decision_time);
      const existing = grouped.get(decisionTime) ?? {
        id: legacyCompetitionDecisionId(record.id, decisionTime),
        competition_id: record.id,
        scheduled_at: decisionTime,
        decided_at: decisionTime,
        status: CompetitionDecisionStatus.COMPLETED,
        winners: []
      };
      if (row.drop_id && row.ranking !== null) {
        existing.winners.push({
          entry_id: legacyCompetitionEntryId(record.id, row.drop_id),
          rank: toNumber(row.ranking),
          final_rating: toNumber(row.final_vote ?? 0)
        });
      }
      grouped.set(decisionTime, existing);
    }
    const decisions = Array.from(grouped.values()).slice(
      request.offset,
      request.offset + request.limit + 1
    );
    return pageFromRows(decisions, request.limit);
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

  public async listLegacyOutcomes(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionOutcome>> {
    const rows = await this.db.execute<{
      wave_outcome_position: number | string;
      type: string;
      subtype: string | null;
      description: string;
      credit: string | null;
      rep_category: string | null;
      amount: number | string | null;
    }>(
      `select * from ${WAVE_OUTCOMES_TABLE} where wave_id = :waveId
       order by wave_outcome_position ${directionSql(request.direction)}
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => {
        const position = toNumber(row.wave_outcome_position);
        return {
          id: legacyCompetitionOutcomeId(record.id, position),
          competition_id: record.id,
          decision_id: null,
          position,
          legacy_index: position,
          type: row.type,
          subtype: row.subtype,
          description: row.description,
          credit: row.credit,
          rep_category: row.rep_category,
          amount: toNumber(row.amount)
        };
      }),
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

  public async listLegacyDistribution(
    record: CompetitionRoutingRecord,
    outcomeId: string,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionDistributionItem>> {
    const outcomes = await collectCompetitionPages((page) =>
      this.listLegacyOutcomes(record, page, ctx)
    );
    const outcome = outcomes.find((candidate) => candidate.id === outcomeId);
    if (outcome?.legacy_index === null || outcome === undefined) {
      return pageFromRows([], request.limit);
    }
    const rows = await this.db.execute<{
      wave_outcome_distribution_item_position: number | string;
      amount: number | string | null;
      description: string | null;
    }>(
      `select * from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE}
       where wave_id = :waveId and wave_outcome_position = :outcomePosition
       order by wave_outcome_distribution_item_position ${directionSql(request.direction)}
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        outcomePosition: outcome.legacy_index,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => {
        const position = toNumber(row.wave_outcome_distribution_item_position);
        return {
          id: legacyCompetitionDistributionItemId(outcomeId, position),
          outcome_id: outcomeId,
          position,
          amount: toNumber(row.amount),
          description: row.description
        };
      }),
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
        end_time: toNumber(row.end_time),
        reason: row.reason
      })),
      request.limit
    );
  }

  public async listLegacyPauses(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionPause>> {
    const rows = await this.db.execute<{
      id: number | string;
      start_time: number | string;
      end_time: number | string | null;
    }>(
      `select * from ${WAVES_DECISION_PAUSES_TABLE}
       where wave_id = :waveId
       order by start_time ${directionSql(request.direction)}, id asc
       limit :offset, :rowLimit`,
      {
        waveId: record.wave_id,
        offset: request.offset,
        rowLimit: request.limit + 1
      },
      dbOptions(ctx)
    );
    return pageFromRows(
      rows.map((row) => ({
        id: legacyCompetitionPauseId(record.id, row.id),
        competition_id: record.id,
        start_time: toNumber(row.start_time),
        end_time: toNumber(row.end_time),
        reason: null
      })),
      request.limit
    );
  }

  public async recordParityObservation(
    observation: {
      readonly waveId: string;
      readonly competitionId: string;
      readonly category: CompetitionParityCategory;
      readonly matched: boolean;
      readonly baselineHash: string;
      readonly candidateHash: string;
      readonly baselineStorageMode: CompetitionStorageMode;
      readonly candidateStorageMode: CompetitionStorageMode;
      readonly baselineConfigVersion: number;
      readonly candidateConfigVersion: number;
      readonly sourceVersion: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${COMPETITION_PARITY_OBSERVATIONS_TABLE}
       (id, wave_id, competition_id, category, matched, baseline_hash,
        candidate_hash, baseline_storage_mode, candidate_storage_mode,
        baseline_config_version, candidate_config_version, source_version,
        observed_at)
       values (:id, :waveId, :competitionId, :category, :matched,
        :baselineHash, :candidateHash, :baselineStorageMode,
        :candidateStorageMode, :baselineConfigVersion,
        :candidateConfigVersion, :sourceVersion, :observedAt)`,
      { id: randomUUID(), ...observation, observedAt: Date.now() },
      dbOptions(ctx)
    );
  }

  private async ensureLegacyCapabilities(
    waveId: string,
    competitionId: string,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    for (const mapping of LEGACY_CAPABILITY_ENV) {
      if (env.getStringOrNull(mapping.envName) !== waveId) continue;
      await this.db.execute(
        `insert into ${COMPETITION_CAPABILITIES_TABLE}
         (capability, competition_id, wave_id, assigned_by,
          legacy_source_wave_id, assigned_at)
         values (:capability, :competitionId, :waveId, null, :waveId, :now)
         on duplicate key update
           competition_id = values(competition_id),
           wave_id = values(wave_id),
           legacy_source_wave_id = values(legacy_source_wave_id)`,
        {
          capability: mapping.capability,
          competitionId,
          waveId,
          now
        },
        dbOptions(ctx)
      );
    }
  }

  private async ensureConfiguredLegacyCapabilities(
    ctx: RequestContext
  ): Promise<void> {
    for (const mapping of LEGACY_CAPABILITY_ENV) {
      const waveId = env.getStringOrNull(mapping.envName);
      if (!waveId) continue;
      const record = await this.db.oneOrNull<CompetitionRoutingRecord>(
        `select id, wave_id, legacy_wave_id, storage_mode, execution_mode
         from ${COMPETITIONS_TABLE} where legacy_wave_id = :waveId`,
        { waveId },
        dbOptions(ctx)
      );
      if (record) await this.ensureLegacyCapabilities(waveId, record.id, ctx);
    }
  }

  public async getLegacyCreditNfts(
    waveId: string,
    ctx: RequestContext
  ): Promise<unknown[]> {
    return this.db.execute(
      `select contract, token_id from ${WAVE_VOTING_CREDIT_NFTS_TABLE}
       where wave_id = :waveId order by contract asc, token_id asc`,
      { waveId },
      dbOptions(ctx)
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

  private mapLegacyEntry(
    record: CompetitionRoutingRecord,
    row: {
      id: string;
      wave_id: string;
      author_id: string;
      created_at: number | string;
      drop_type: DropType;
      config_version: number | string;
      rank: number | string | null;
      decision_time: number | string | null;
      ranking: number | string | null;
    }
  ): CompetitionEntry {
    const decisionTime = toNumber(row.decision_time);
    return {
      id: legacyCompetitionEntryId(record.id, row.id),
      wave_id: row.wave_id,
      competition_id: record.id,
      drop_id: row.id,
      submitter_id: row.author_id,
      status:
        row.drop_type === DropType.WINNER
          ? CompetitionEntryStatus.WINNER
          : CompetitionEntryStatus.ACTIVE,
      config_version: toNumber(row.config_version),
      submitted_at: toNumber(row.created_at),
      rank: toNumber(row.ranking ?? row.rank),
      won_at: decisionTime,
      decision_id:
        decisionTime === null
          ? null
          : legacyCompetitionDecisionId(record.id, decisionTime)
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

  private dropTypesForStatuses(
    statuses?: readonly CompetitionEntryStatus[]
  ): DropType[] {
    if (!statuses?.length) return [DropType.PARTICIPATORY, DropType.WINNER];
    const types = new Set<DropType>();
    if (statuses.includes(CompetitionEntryStatus.ACTIVE)) {
      types.add(DropType.PARTICIPATORY);
    }
    if (statuses.includes(CompetitionEntryStatus.WINNER)) {
      types.add(DropType.WINNER);
    }
    return Array.from(types);
  }

  private async findLegacyDropIdByEntry(
    record: CompetitionRoutingRecord,
    entryId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const rows = await this.db.execute<{ id: string }>(
      `select id from ${DROPS_TABLE}
       where wave_id = :waveId and drop_type in (:dropTypes)`,
      {
        waveId: record.wave_id,
        dropTypes: [DropType.PARTICIPATORY, DropType.WINNER]
      },
      dbOptions(ctx)
    );
    return (
      rows.find(
        (row) => legacyCompetitionEntryId(record.id, row.id) === entryId
      )?.id ?? null
    );
  }

  private async findNativeDecisionWinners(
    decisionIds: readonly string[],
    ctx: RequestContext
  ): Promise<NativeDecisionWinnerRecord[]> {
    if (!decisionIds.length) return [];
    return this.db.execute<NativeDecisionWinnerRecord>(
      `select * from ${COMPETITION_DECISION_WINNERS_TABLE}
       where decision_id in (:decisionIds) order by \`rank\` asc, entry_id asc`,
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
