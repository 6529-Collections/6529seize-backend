import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  WALLETS_CONSOLIDATION_KEYS_VIEW
} from '../../../constants';
import { sqlExecutor } from '../../../sql-executor';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '../../../entities/ISubscription.ts';
import { constructFilters } from 'src/api-helpers';
import { fetchPaginated } from '../../../db-api';

export async function fetchBalanceForConsolidationKey(
  consolidationKey: string
): Promise<SubscriptionBalance> {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE} WHERE consolidation_key = :consolidation_key`,
    { consolidation_key: consolidationKey }
  );
  if (result.length === 1) {
    return result[0];
  }
  return null;
}

export async function fetchTopUpsForConsolidationKey(
  consolidationKey: string,
  pageSize: number,
  page: number
): Promise<{
  count: number;
  page: number;
  next: boolean;
  data: SubscriptionTopUp[];
}> {
  const wallets: string[] = (
    await sqlExecutor.execute(
      `SELECT * FROM ${WALLETS_CONSOLIDATION_KEYS_VIEW} WHERE consolidation_key = :consolidation_key`,
      { consolidation_key: consolidationKey }
    )
  ).map((wallet: any) => wallet.wallet);

  const filters = constructFilters('', `from_wallet IN (:wallets)`);
  const params = { wallets };

  return fetchPaginated(
    SUBSCRIPTIONS_TOP_UP_TABLE,
    params,
    'block desc',
    pageSize,
    page,
    filters,
    ''
  );
}
