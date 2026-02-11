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
  ): Promise<void> {
    if (delta.credit_spent_delta === 0) {
      return;
    }
    const now = Time.currentMillis();
    await this.db.execute(
      `insert into ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE}
      (proxy_action_id, matter, matter_target_id, matter_category, credit_spent_outstanding, created_at, updated_at)
      values
      (:proxy_action_id, :matter, :matter_target_id, :matter_category, :initial_credit_spent_outstanding, :now, :now)
      on duplicate key update
        credit_spent_outstanding = greatest(0, credit_spent_outstanding + :credit_spent_delta),
        updated_at = :now`,
      {
        ...delta,
        now,
        initial_credit_spent_outstanding: Math.max(delta.credit_spent_delta, 0)
      },
      connection ? { wrappedConnection: connection } : undefined
    );
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
