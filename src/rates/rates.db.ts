import {
  LazyDbAccessCompatibleService,
  dbSupplier,
  ConnectionWrapper
} from '../sql-executor';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  PROFILES_TABLE,
  RATE_EVENTS_TABLE,
  RATE_MATTERS_CATEGORIES_TABLE
} from '../constants';
import { RateEvent } from '../entities/IRateEvent';
import {
  RateMatterCategory,
  RateMatterTargetType
} from '../entities/IRateMatter';

export class RatesDb extends LazyDbAccessCompatibleService {
  public async getAllProfilesTdhs(
    connectionHolder?: ConnectionWrapper<any>
  ): Promise<{ tdh: number; profile_id: string }[]> {
    return this.db.execute(
      `
          with b_and_w as (SELECT T.boosted_tdh
                                , data.wallet
                           FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} T
                                    INNER JOIN JSON_TABLE
                               (
                                   T.wallets,
                                   "$[*]" COLUMNS (
                             wallet varchar(50) COLLATE utf8mb4_0900_ai_ci PATH "$"
                             )
                               ) data)
          select ${PROFILES_TABLE}.external_id           as profile_id,
                 b_and_w.boosted_tdh            as tdh
          from b_and_w
                   inner join ${PROFILES_TABLE} on lower(${PROFILES_TABLE}.primary_wallet) = lower(b_and_w.wallet)
         `,
      undefined,
      { wrappedConnection: connectionHolder?.connection }
    );
  }

  public async getTdhInfoForProfile(
    profileId: string,
    connectionHolder?: ConnectionWrapper<any>
  ): Promise<number> {
    const allProfilesTdhs = await this.getAllProfilesTdhs(connectionHolder);
    return allProfilesTdhs.find((it) => it.profile_id === profileId)?.tdh ?? 0;
  }

  public async getToBeRevokedEvents(
    overRate: {
      tdh: number;
      tally: number;
      matter: string;
      matter_target_type: string;
      profileId: string;
    },
    overRateAmount: number,
    connectionHolder: ConnectionWrapper<any>
  ): Promise<RateEvent[]> {
    return await this.db.execute(
      `WITH full_overrates AS (SELECT NULL AS id, NULL AS total
                               FROM dual
                               WHERE (@total := 0)
                               UNION
                               SELECT ve.id, @total := @total + ve.amount AS total
                               FROM (SELECT id, amount
                                     FROM rate_events
                                     WHERE rater = :raterProfile
                                       AND matter = :matter
                                     ORDER BY created_time desc) ve
                               WHERE @total < :overRateAmount)
       SELECT *
       FROM rate_events
       WHERE id IN (SELECT id FROM full_overrates)
       ORDER BY created_time DESC`,
      {
        matter: overRate.matter,
        overRateAmount: overRateAmount,
        raterProfile: overRate.profileId
      },
      { wrappedConnection: connectionHolder }
    );
  }

  public async getActiveRateTalliesGroupedByRaterMatterAndTarget(): Promise<
    {
      rater: string;
      matter: string;
      matter_target_type: RateMatterTargetType;
      rate_tally: number;
    }[]
  > {
    return this.db.execute(
      `
      select 
        r.rater, 
        r.matter, 
        r.matter_target_type,
        abs(sum(r.amount)) as rate_tally 
      from ${RATE_EVENTS_TABLE} r
      group by r.rater, r.matter, r.matter_target_type`
    );
  }

  public async getRatesTallyOnMatterByProfileId({
    profileId,
    matter,
    matterTargetType,
    connectionHolder
  }: {
    profileId: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
    connectionHolder?: ConnectionWrapper<any>;
  }): Promise<number> {
    if (!profileId.length) {
      return 0;
    }
    const result: { rates_spent: number }[] = await this.db.execute(
      `SELECT SUM(amount) AS rates_spent FROM ${RATE_EVENTS_TABLE}
     WHERE rater = :profileId 
     AND matter = :matter 
     AND matter_target_type = :matterTargetType`,
      {
        matter,
        matterTargetType,
        profileId
      },
      { wrappedConnection: connectionHolder?.connection }
    );
    return result.at(0)?.rates_spent ?? 0;
  }

  public async getTotalRatesTallyOnMatterByProfileId({
    profileId,
    matter,
    matterTargetType,
    matterTargetId,
    connectionHolder
  }: {
    profileId: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
    matterTargetId: string;
    connectionHolder?: ConnectionWrapper<any>;
  }): Promise<number> {
    if (!profileId.length) {
      return 0;
    }
    const result: { tally: number }[] = await this.db.execute(
      `SELECT SUM(amount) AS tally FROM ${RATE_EVENTS_TABLE}
     WHERE rater = :profileId 
     AND matter = :matter 
     AND matter_target_type = :matterTargetType
     AND matter_target_id = :matterTargetId`,
      {
        matter,
        matterTargetType,
        profileId,
        matterTargetId
      },
      { wrappedConnection: connectionHolder?.connection }
    );
    return result.at(0)?.tally ?? 0;
  }

  public async getCategoriesForMatter({
    matter,
    matterTargetType
  }: {
    matter: string;
    matterTargetType: RateMatterTargetType;
  }): Promise<RateMatterCategory[]> {
    return this.db.execute(
      `SELECT * FROM ${RATE_MATTERS_CATEGORIES_TABLE} 
    WHERE matter_target_type = :matterTargetType 
    AND matter = :matter`,
      { matterTargetType, matter }
    );
  }

  public async insertRateEvent(
    event: RateEvent,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `INSERT INTO ${RATE_EVENTS_TABLE} (id,
                                       rater,
                                       matter_target_id,
                                       matter_target_type,
                                       matter,
                                       matter_category,
                                       event_reason,
                                       amount,
                                       created_time)
     values (:id,
             :rater,
             :matterTargetId,
             :matterTargetType,
             :matter,
             :matterCategory,
             :eventReason,
             :amount,
             current_time)`,
      {
        id: event.id,
        rater: event.rater,
        matterTargetId: event.matter_target_id,
        matterTargetType: event.matter_target_type,
        matter: event.matter,
        matterCategory: event.matter_category,
        eventReason: event.event_reason,
        amount: event.amount
      },
      { wrappedConnection: connectionHolder.connection }
    );
  }

  public async getRatesTallyForProfileOnMatterByCategories({
    profileId,
    matter,
    matterTargetType,
    matterTargetId,
    connectionHolder
  }: {
    profileId: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
    matterTargetId: string;
    connectionHolder?: ConnectionWrapper<any>;
  }): Promise<Record<string, number>> {
    const result: { matter_category: string; rate_tally: number }[] =
      await this.db.execute(
        `SELECT matter_category, SUM(amount) AS rate_tally FROM ${RATE_EVENTS_TABLE}
      WHERE rater = :profileId
      AND matter = :matter
      AND matter_target_type = :matterTargetType
      AND matter_target_id = :matterTargetId
      GROUP BY matter_category`,
        {
          profileId,
          matter,
          matterTargetType,
          matterTargetId
        },
        { wrappedConnection: connectionHolder?.connection }
      );
    return (result ?? []).reduce((acc, row) => {
      acc[row.matter_category] = row.rate_tally;
      return acc;
    }, {} as Record<string, number>);
  }

  public async getTotalTalliesByCategories(
    matterTargetType: RateMatterTargetType,
    matterTargetId: string,
    matter: string
  ): Promise<Record<string, number>> {
    const totalTallies: {
      matter_category: string;
      rate_tally: number;
    }[] = await this.db.execute(
      `SELECT matter_category, SUM(amount) AS rate_tally FROM ${RATE_EVENTS_TABLE}
    WHERE matter_target_type = :matterTargetType
    AND matter_target_id = :matterTargetId
    AND matter = :matter
    GROUP BY matter, matter_category`,
      { matterTargetType, matterTargetId, matter }
    );
    return totalTallies.reduce((acc, row) => {
      acc[row.matter_category] = row.rate_tally;
      return acc;
    }, {} as Record<string, number>);
  }
}

export const ratesDb = new RatesDb(dbSupplier);
