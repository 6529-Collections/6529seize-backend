import {
  COMPETITIONS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_SCORE_RESETS_TABLE,
  COMPETITION_SCORE_RESET_STATE_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export const SCORE_RESET_STATE_ID = 'latest-reset';

/** Keep the ordering and three independent streams identical to listHistory. */
export const legacyScoreResetsSql = `select
  json_unquote(json_extract(event,'$.competition_entry_id')) as entry_id,
  cast(json_unquote(json_extract(event,'$.data.content_revision')) as unsigned) as content_revision,
  cast(json_unquote(json_extract(event,'$.data.vote_history_sequence')) as unsigned) as vote_history_sequence,
  cast(json_unquote(json_extract(event,'$.data.aggregate_history_sequence')) as unsigned) as aggregate_history_sequence,
  cast(json_unquote(json_extract(event,'$.data.voter_history_sequence')) as unsigned) as voter_history_sequence,
  created_at as source_created_at,id as source_id,
  row_number() over (
    partition by json_unquote(json_extract(event,'$.competition_entry_id'))
    order by cast(json_unquote(json_extract(event,'$.data.content_revision')) as unsigned) desc,
      created_at desc,id desc
  ) as reset_order
  from ${COMPETITION_OUTBOX_TABLE}
  where competition_id=:competitionId
    and json_unquote(json_extract(event,'$.event_type'))='COMPETITION_ENTRY_UPDATED'
    and json_contains_path(event,'all','$.data.vote_history_sequence',
      '$.data.aggregate_history_sequence','$.data.voter_history_sequence')`;

const resetColumns = [
  'content_revision',
  'vote_history_sequence',
  'aggregate_history_sequence',
  'voter_history_sequence',
  'source_created_at',
  'source_id'
] as const;

export type ScoreResetProgress = {
  after_competition_id: string;
  backfill_complete: boolean;
  reads_enabled: boolean;
};

export class CompetitionScoreResetRepository extends LazyDbAccessCompatibleService {
  private async query<T>(
    operation: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${operation}`;
    ctx.timer?.start(name);
    try {
      return await this.db.execute<T>(
        sql,
        params,
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(name);
    }
  }

  public async progress(ctx: RequestContext): Promise<ScoreResetProgress> {
    const [row] = await this.query<ScoreResetProgress>(
      'progress',
      `select after_competition_id,backfill_complete,reads_enabled
       from ${COMPETITION_SCORE_RESET_STATE_TABLE} where id=:id`,
      { id: SCORE_RESET_STATE_ID },
      ctx
    );
    return {
      after_competition_id: row?.after_competition_id ?? '',
      backfill_complete: Boolean(row?.backfill_complete),
      reads_enabled: Boolean(row?.reads_enabled)
    };
  }

  /** Project the stored event, so an idempotent retry cannot change its data. */
  public async projectEvent(
    eventId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Score reset projection requires a transaction');
    const [event] = await this.query<{ competition_id: string }>(
      'findEvent',
      `select competition_id from ${COMPETITION_OUTBOX_TABLE} where id=:eventId`,
      { eventId },
      ctx
    );
    if (!event) throw new Error('Score reset source event is missing');
    await this.copy(event.competition_id, eventId, ctx);
  }

  private async copy(
    competitionId: string,
    eventId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    // Update cutoffs before the ordering fields: MySQL evaluates assignments
    // left to right. Never replace a newer live reset with an older backfill.
    const stored = (column: string) =>
      `${COMPETITION_SCORE_RESETS_TABLE}.${column}`;
    const newer = `((${stored('content_revision')} is null and values(content_revision) is not null)
      or values(content_revision)>${stored('content_revision')}
      or ((values(content_revision)<=>${stored('content_revision')}) and
        (values(source_created_at)>${stored('source_created_at')} or
          (values(source_created_at)=${stored('source_created_at')} and values(source_id)>${stored('source_id')}))))`;
    const updates = [
      'vote_history_sequence',
      'aggregate_history_sequence',
      'voter_history_sequence',
      'source_id',
      'source_created_at',
      'content_revision'
    ]
      .map(
        (column) => `${column}=if(${newer},values(${column}),${stored(column)})`
      )
      .join(',');
    await this.query(
      'copy',
      `insert into ${COMPETITION_SCORE_RESETS_TABLE}
       (competition_id,entry_id,${resetColumns.join(',')})
       select :competitionId,source.entry_id,${resetColumns.map((column) => `source.${column}`).join(',')} from (
         ${legacyScoreResetsSql}${eventId === null ? '' : ' and id=:eventId'}
       ) source where reset_order=1 and entry_id is not null
       on duplicate key update ${updates}`,
      { competitionId, eventId },
      ctx
    );
  }

  /** One competition per transaction; restarting resumes after the last commit. */
  public async backfillNext(): Promise<boolean> {
    return this.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        await this.query(
          'initialize',
          `insert ignore into ${COMPETITION_SCORE_RESET_STATE_TABLE} (id) values (:id)`,
          { id: SCORE_RESET_STATE_ID },
          ctx
        );
        const [state] = await this.query<ScoreResetProgress>(
          'lockProgress',
          `select * from ${COMPETITION_SCORE_RESET_STATE_TABLE} where id=:id for update`,
          { id: SCORE_RESET_STATE_ID },
          ctx
        );
        if (state.reads_enabled)
          throw new Error('Disable projected reads before backfilling');
        if (state.backfill_complete) return false;
        const [competition] = await this.query<{ id: string }>(
          'nextCompetition',
          `select id from ${COMPETITIONS_TABLE} where id>:afterId order by id limit 1`,
          { afterId: state.after_competition_id },
          ctx
        );
        if (!competition) {
          await this.query(
            'complete',
            `update ${COMPETITION_SCORE_RESET_STATE_TABLE} set backfill_complete=1 where id=:id`,
            { id: SCORE_RESET_STATE_ID },
            ctx
          );
          return false;
        }
        // Edits use the same lock; all upgraded writers must be deployed before
        // this one-time scan starts. Each reset and its event commit together.
        await this.query(
          'lockCompetition',
          `select id from ${COMPETITIONS_TABLE} where id=:competitionId for update`,
          { competitionId: competition.id },
          ctx
        );
        await this.copy(competition.id, null, ctx);
        const [verification] = await this.query<{ mismatches: number }>(
          'verify',
          `select count(*) as mismatches from (${legacyScoreResetsSql}) source
         left join ${COMPETITION_SCORE_RESETS_TABLE} r
           on r.competition_id=:competitionId and r.entry_id=source.entry_id
         where source.reset_order=1 and source.entry_id is not null and
           (r.entry_id is null or not (${resetColumns.map((column) => `r.${column}<=>source.${column}`).join(' and ')}))`,
          { competitionId: competition.id },
          ctx
        );
        if (Number(verification.mismatches))
          throw new Error('Score reset backfill verification failed');
        await this.query(
          'advance',
          `update ${COMPETITION_SCORE_RESET_STATE_TABLE} set after_competition_id=:afterId where id=:id`,
          { afterId: competition.id, id: SCORE_RESET_STATE_ID },
          ctx
        );
        return true;
      },
      { isolationLevel: 'READ COMMITTED' }
    );
  }

  public async setReadsEnabled(enabled: boolean): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const ctx = { connection };
      const [state] = await this.query<ScoreResetProgress>(
        'lockProgress',
        `select * from ${COMPETITION_SCORE_RESET_STATE_TABLE} where id=:id for update`,
        { id: SCORE_RESET_STATE_ID },
        ctx
      );
      if (enabled && !state?.backfill_complete)
        throw new Error('Score reset backfill must be complete before cutover');
      await this.query(
        'setReadsEnabled',
        `update ${COMPETITION_SCORE_RESET_STATE_TABLE} set reads_enabled=:enabled${enabled ? '' : ",backfill_complete=0,after_competition_id=''"} where id=:id`,
        { enabled, id: SCORE_RESET_STATE_ID },
        ctx
      );
    });
  }
}

export const competitionScoreResetRepository =
  new CompetitionScoreResetRepository(dbSupplier);
