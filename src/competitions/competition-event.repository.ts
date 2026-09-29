import {
  COMPETITION_EVENT_EFFECTS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CLAIMS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  NativeCompetitionEvent,
  NativeDecisionWinner
} from './native-competition-runtime.repository';
import { stableUuid } from './competition-id';
import { publicCompetitionWaveSql } from './competition-main-stage.repository';

export type CompetitionEventContext = {
  readonly title: string;
  readonly lifecycle: string;
  readonly published_at: number | null;
  readonly visibility_group_id: string | null;
};

export type NativeClaimContext = {
  readonly competition_id: string;
  readonly competition_entry_id: string;
  readonly decision_id: string;
};

export class CompetitionEventRepository extends LazyDbAccessCompatibleService {
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

  public async getContext(
    event: NativeCompetitionEvent,
    ctx: RequestContext
  ): Promise<CompetitionEventContext | null> {
    const rows = await this.query<CompetitionEventContext>(
      'getContext',
      `select c.title, c.lifecycle, c.published_at, w.visibility_group_id
      from ${COMPETITIONS_TABLE} c join ${WAVES_TABLE} w on w.id = c.wave_id
      where c.id = :competitionId and c.wave_id = :waveId and c.storage_mode = 'NATIVE'`,
      { competitionId: event.competition_id, waveId: event.wave_id },
      ctx
    );
    return rows[0] ?? null;
  }

  public async listFollowers(
    waveId: string,
    afterId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const rows = await this.query<{ subscriber_id: string }>(
      'listFollowers',
      `select distinct subscriber_id from ${IDENTITY_SUBSCRIPTIONS_TABLE}
      where target_type = 'WAVE' and target_id = :waveId and subscriber_id > :afterId order by subscriber_id asc limit 500`,
      { waveId, afterId },
      ctx
    );
    return rows.map((row) => row.subscriber_id);
  }

  public async getEntrySubmitter(
    competitionId: string,
    entryId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const rows = await this.query<{ submitter_id: string }>(
      'getEntrySubmitter',
      `select submitter_id from ${COMPETITION_ENTRIES_TABLE}
      where competition_id = :competitionId and id = :entryId`,
      { competitionId, entryId },
      ctx
    );
    return rows[0]?.submitter_id ?? null;
  }

  /** Durable receipt and DB effect commit together. A retried or concurrent
   * consumer returns the original result without recreating notifications/drops. */
  public async applyEffect<T>(
    eventId: string,
    key: string,
    apply: (ctx: RequestContext) => Promise<T>,
    ctx: RequestContext = {}
  ): Promise<T> {
    if (!ctx.connection)
      return this.executeNativeQueriesInTransaction((connection) =>
        this.applyEffect(eventId, key, apply, { ...ctx, connection })
      );
    const id = stableUuid(eventId, key);
    await this.query(
      'applyEffect',
      `insert ignore into ${COMPETITION_EVENT_EFFECTS_TABLE} (id, event_id, effect_key) values (:id, :eventId, :key)`,
      { id, eventId, key },
      ctx
    );
    const [receipt] = await this.query<{
      result: string | T;
      completed_at: number | null;
    }>(
      'applyEffect',
      `select result, completed_at from ${COMPETITION_EVENT_EFFECTS_TABLE} where id = :id for update`,
      { id },
      ctx
    );
    if (receipt.completed_at !== null)
      return typeof receipt.result === 'string'
        ? (JSON.parse(receipt.result) as T)
        : receipt.result;
    const result = await apply(ctx);
    await this.query(
      'applyEffect',
      `update ${COMPETITION_EVENT_EFFECTS_TABLE} set result = :result, completed_at = :now where id = :id`,
      { id, result: JSON.stringify(result), now: Date.now() },
      ctx
    );
    return result;
  }

  public async getPrivilegedWinners(
    competitionId: string,
    decisionId: string,
    ctx: RequestContext
  ): Promise<NativeDecisionWinner[]> {
    if (ctx.connection)
      await this.query(
        'getPrivilegedWinners',
        `select id from ${COMPETITIONS_TABLE} where id = :id for update`,
        { id: competitionId },
        ctx
      );
    if (ctx.connection)
      await this.query(
        'getPrivilegedWinners',
        `select access_wave.id from ${WAVES_TABLE} access_wave
         where access_wave.id in (
           select c.wave_id from ${COMPETITIONS_TABLE} c where c.id = :competitionId
           union select hub.parent_wave_id from ${COMPETITIONS_TABLE} c
             join ${WAVES_TABLE} hub on hub.id = c.wave_id where c.id = :competitionId
         ) order by access_wave.id for update`,
        { competitionId },
        ctx
      );
    const rows = await this.query<NativeDecisionWinner>(
      'getPrivilegedWinners',
      `select e.id as entry_id, e.drop_id, e.submitter_id, w.\`rank\`, w.final_rating
      from ${COMPETITION_ENTRIES_TABLE} e
      join ${COMPETITION_DECISION_WINNERS_TABLE} w on w.entry_id = e.id and w.decision_id = e.decision_id and w.competition_id = e.competition_id
      join ${COMPETITIONS_TABLE} c on c.id = e.competition_id and c.storage_mode = 'NATIVE'
      join ${WAVES_TABLE} hub on hub.id = c.wave_id and ${publicCompetitionWaveSql('hub')}
      join ${COMPETITION_CAPABILITIES_TABLE} cap on cap.competition_id = c.id and cap.wave_id = c.wave_id and cap.capability = 'MAIN_STAGE'
      where e.competition_id = :competitionId and e.decision_id = :decisionId and e.status = 'WINNER'
        and c.lifecycle in ('PUBLISHED', 'ENDED') order by w.\`rank\` asc, e.id asc`,
      { competitionId, decisionId },
      ctx
    );
    return rows.map((row) => ({
      ...row,
      rank: Number(row.rank),
      final_rating: Number(row.final_rating)
    }));
  }

  public async assertNativeClaim(
    context: NativeClaimContext,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Native claim verification requires a transaction');
    await this.query(
      'assertNativeClaim',
      `select id from ${COMPETITIONS_TABLE} where id = :id for update`,
      { id: context.competition_id },
      ctx
    );
    const winners = await this.getPrivilegedWinners(
      context.competition_id,
      context.decision_id,
      ctx
    );
    if (
      !winners.some(
        (winner) =>
          winner.entry_id === context.competition_entry_id &&
          winner.drop_id === dropId &&
          winner.rank === 1
      )
    ) {
      throw new Error(
        'Native claim requires its explicitly designated Main Stage winner'
      );
    }
  }

  public async recordNativeClaim(
    context: NativeClaimContext,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Native claim provenance requires a transaction');
    await this.query(
      'recordNativeClaim',
      `insert ignore into ${COMPETITION_CLAIMS_TABLE}
      (drop_id, competition_id, entry_id, decision_id, created_at) values (:dropId, :competitionId, :entryId, :decisionId, :now)`,
      {
        dropId,
        competitionId: context.competition_id,
        entryId: context.competition_entry_id,
        decisionId: context.decision_id,
        now: Date.now()
      },
      ctx
    );
    const rows = await this.query<{
      competition_id: string;
      entry_id: string;
      decision_id: string;
    }>(
      'recordNativeClaim',
      `select competition_id, entry_id, decision_id
      from ${COMPETITION_CLAIMS_TABLE} where drop_id = :dropId for update`,
      { dropId },
      ctx
    );
    const row = rows[0];
    if (
      !row ||
      row.competition_id !== context.competition_id ||
      row.entry_id !== context.competition_entry_id ||
      row.decision_id !== context.decision_id
    ) {
      throw new Error(
        'This drop already has a claim from another competition entry'
      );
    }
  }
}

export const competitionEventRepository = new CompetitionEventRepository(
  dbSupplier
);
