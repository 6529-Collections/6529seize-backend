import { PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE } from '@/constants';
import { RateMatter } from '@/entities/IRating';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

export interface ProxyRatingCreditBalanceDelta {
  readonly proxy_action_id: string;
  readonly matter: RateMatter;
  readonly matter_target_id: string;
  readonly matter_category: string;
  readonly credit_spent_delta: number;
}

export class ProfileProxyRatingCreditBalancesDb extends LazyDbAccessCompatibleService {
  async applyCreditSpentDelta(
    delta: ProxyRatingCreditBalanceDelta,
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    if (delta.credit_spent_delta === 0) {
      return 0;
    }
    if (!connection) {
      throw new Error(
        'Proxy credit balance updates must be executed inside a transaction'
      );
    }
    const now = Time.currentMillis();

    const existing = await this.db.oneOrNull<{
      id: number;
      credit_spent_outstanding: number;
    }>(
      `select id, credit_spent_outstanding
      from ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      where proxy_action_id = :proxy_action_id
        and matter = :matter
        and matter_target_id = :matter_target_id
        and matter_category = :matter_category
      for update`,
      {
        proxy_action_id: delta.proxy_action_id,
        matter: delta.matter,
        matter_target_id: delta.matter_target_id,
        matter_category: delta.matter_category
      },
      { wrappedConnection: connection }
    );

    if (delta.credit_spent_delta > 0) {
      if (!existing) {
        await this.db.execute(
          `insert into ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
          (
            proxy_action_id,
            matter,
            matter_target_id,
            matter_category,
            credit_spent_outstanding,
            created_at,
            updated_at
          )
          values
          (
            :proxy_action_id,
            :matter,
            :matter_target_id,
            :matter_category,
            :credit_spent_outstanding,
            :now,
            :now
          )
          on duplicate key update
            credit_spent_outstanding = credit_spent_outstanding + values(credit_spent_outstanding),
            updated_at = values(updated_at)`,
          {
            proxy_action_id: delta.proxy_action_id,
            matter: delta.matter,
            matter_target_id: delta.matter_target_id,
            matter_category: delta.matter_category,
            credit_spent_outstanding: delta.credit_spent_delta,
            now
          },
          { wrappedConnection: connection }
        );
      } else {
        await this.db.execute(
          `update ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
          set credit_spent_outstanding = credit_spent_outstanding + :credit_spent_delta,
              updated_at = :now
          where id = :id`,
          {
            id: existing.id,
            credit_spent_delta: delta.credit_spent_delta,
            now
          },
          { wrappedConnection: connection }
        );
      }
      return delta.credit_spent_delta;
    }

    if (!existing) {
      return 0;
    }
    const refundableAmount = Math.min(
      Math.abs(delta.credit_spent_delta),
      existing.credit_spent_outstanding ?? 0
    );
    if (refundableAmount <= 0) {
      return 0;
    }
    await this.db.execute(
      `update ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      set credit_spent_outstanding = credit_spent_outstanding - :refundable_amount,
          updated_at = :now
      where id = :id`,
      {
        id: existing.id,
        refundable_amount: refundableAmount,
        now
      },
      { wrappedConnection: connection }
    );
    return -refundableAmount;
  }

  async getOutstandingCreditsByActionIds({
    action_ids,
    connection
  }: {
    readonly action_ids: string[];
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<Record<string, number>> {
    if (!action_ids.length) {
      return {};
    }
    const rows = await this.db.execute<{
      proxy_action_id: string;
      credit_spent_outstanding: number;
    }>(
      `select proxy_action_id, sum(credit_spent_outstanding) as credit_spent_outstanding
      from ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      where proxy_action_id in (:action_ids)
      group by 1`,
      { action_ids },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows.reduce(
      (acc, row) => {
        acc[row.proxy_action_id] = row.credit_spent_outstanding ?? 0;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async migrateMatterTargetId({
    oldTargetId,
    newTargetId,
    connection
  }: {
    readonly oldTargetId: string;
    readonly newTargetId: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    if (oldTargetId === newTargetId) {
      return;
    }
    const now = Time.currentMillis();
    await this.db.execute(
      `insert into ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      (
        proxy_action_id,
        matter,
        matter_target_id,
        matter_category,
        credit_spent_outstanding,
        created_at,
        updated_at
      )
      select
        proxy_action_id,
        matter,
        :newTargetId,
        matter_category,
        credit_spent_outstanding,
        created_at,
        :now
      from ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      where matter_target_id = :oldTargetId
      on duplicate key update
        credit_spent_outstanding = credit_spent_outstanding + values(credit_spent_outstanding),
        updated_at = values(updated_at)`,
      {
        oldTargetId,
        newTargetId,
        now
      },
      connection ? { wrappedConnection: connection } : undefined
    );

    await this.db.execute(
      `delete from ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      where matter_target_id = :oldTargetId`,
      { oldTargetId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export const profileProxyRatingCreditBalancesDb =
  new ProfileProxyRatingCreditBalancesDb(dbSupplier);
