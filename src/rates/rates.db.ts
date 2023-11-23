import {
  LazyDbAccessCompatibleService,
  dbSupplier,
  ConnectionWrapper
} from '../sql-executor';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  RATE_EVENTS_TABLE,
  RATE_MATTERS_CATEGORIES_TABLE
} from '../constants';
import { RateEvent } from '../entities/IRateEvent';
import {
  RateMatterCategory,
  RateMatterTargetType
} from '../entities/IRateMatter';

export class RatesDb extends LazyDbAccessCompatibleService {
  public async getAllTdhs(): Promise<{ tdh: number; wallets: string[] }[]> {
    return this.db
      .execute(`select tdh, wallets from ${CONSOLIDATED_WALLETS_TDH_TABLE}`)
      .then((rows) =>
        rows.map((row: any) => ({
          ...row,
          wallets: JSON.parse(row.wallets).map((it: string) => it.toLowerCase())
        }))
      );
  }

  public async getTdhInfoForWallet(
    wallet: string
  ): Promise<{ block: number; tdh: number; wallets: string[] } | null> {
    return await this.db
      .execute(
        `SELECT block, boosted_tdh as tdh, wallets FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} WHERE LOWER(consolidation_key) LIKE :wallet`,
        { wallet: `%${wallet.toLowerCase()}%` }
      )
      .then(
        (result: any[]) =>
          result
            .map((row) => ({
              ...row,
              wallets: JSON.parse(row.wallets).map((it: string) =>
                it.toLowerCase()
              )
            }))
            .at(0) ?? null
      );
  }

  public async getToBeRevokedEvents(
    overRate: {
      tdh: number;
      tally: number;
      matter: string;
      matter_target_type: string;
      rate_participating_wallets: string[];
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
                                     WHERE LOWER(rater) IN (:rateParticipantsIn)
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
        rateParticipantsIn: overRate.rate_participating_wallets.map((it) =>
          it.toLowerCase()
        )
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
      `select rater, matter, matter_target_type, sum(amount) as rate_tally from ${RATE_EVENTS_TABLE} group by rater, matter, matter_target_type`
    );
  }

  public async getTotalRatesSpentOnMatterByWallets({
    wallets,
    matter,
    matterTargetType
  }: {
    wallets: string[];
    matter: string;
    matterTargetType: RateMatterTargetType;
  }): Promise<number> {
    if (!wallets.length) {
      return 0;
    }
    const result: { rates_spent: number }[] = await this.db.execute(
      `SELECT SUM(amount) AS rates_spent FROM ${RATE_EVENTS_TABLE}
     WHERE LOWER(rater) IN (:wallets) 
     AND matter = :matter 
     AND matter_target_type = :matterTargetType`,
      {
        matter,
        matterTargetType,
        wallets: wallets.map((it) => it.toLowerCase())
      }
    );
    return result.at(0)?.rates_spent ?? 0;
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
    connectionHolder?: ConnectionWrapper<any>
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
      { wrappedConnection: connectionHolder?.connection }
    );
  }

  public async getRatesTallyForWalletOnMatterByCategories({
    wallets,
    matter,
    matterTargetType,
    matterTargetId
  }: {
    wallets: string[];
    matter: string;
    matterTargetType: RateMatterTargetType;
    matterTargetId: string;
  }): Promise<Record<string, number>> {
    if (!wallets.length) {
      return {};
    }
    const result: { matter_category: string; rate_tally: number }[] =
      await this.db.execute(
        `SELECT matter_category, SUM(amount) AS rate_tally FROM ${RATE_EVENTS_TABLE}
      WHERE LOWER(rater) IN (:wallets)
      AND matter = :matter
      AND matter_target_type = :matterTargetType
      AND matter_target_id = :matterTargetId
      GROUP BY matter_category`,
        {
          wallets: wallets.map((it) => it.toLowerCase()),
          matter,
          matterTargetType,
          matterTargetId
        }
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
