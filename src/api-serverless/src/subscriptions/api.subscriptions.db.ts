import {
  PROFILE_FULL,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  WALLETS_CONSOLIDATION_KEYS_VIEW
} from '../../../constants';
import { sqlExecutor } from '../../../sql-executor';
import {
  SubscriptionBalance,
  SubscriptionMode,
  SubscriptionTopUp
} from '../../../entities/ISubscription.ts';
import { constructFilters } from 'src/api-helpers';
import { fetchPaginated } from '../../../db-api';

export interface SubscriptionDetails {
  consolidation_key: string;
  last_update: number;
  balance: number;
  automatic: boolean;
}

async function getForConsolidationKey(consolidationKey: string, table: string) {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${table} WHERE consolidation_key = :consolidation_key`,
    { consolidation_key: consolidationKey }
  );
  if (result.length === 1) {
    return result[0];
  }
  return null;
}

export async function fetchDetailsForConsolidationKey(
  consolidationKey: string
): Promise<SubscriptionDetails> {
  const balance: SubscriptionBalance = await getForConsolidationKey(
    consolidationKey,
    SUBSCRIPTIONS_BALANCES_TABLE
  );
  const mode: SubscriptionMode = await getForConsolidationKey(
    consolidationKey,
    SUBSCRIPTIONS_MODE_TABLE
  );

  return {
    consolidation_key: consolidationKey,
    last_update: Math.max(
      new Date(balance?.updated_at)?.getTime() ?? 0,
      new Date(mode?.updated_at)?.getTime() ?? 0
    ),
    balance: balance?.balance ?? 0,
    automatic: !!mode?.automatic
  };
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

export async function fetchConsolidationWallets(
  consolidationKey: string
): Promise<string[]> {
  const consolidation = await sqlExecutor.execute(
    `SELECT * FROM ${PROFILE_FULL} WHERE consolidation_key = :consolidationKey`,
    { consolidationKey: consolidationKey.toLowerCase() }
  );
  if (!consolidation) {
    throw new Error('Consolidation not found');
  }
  return [consolidation.wallet1, consolidation.wallet2, consolidation.wallet3];
}

export async function updateSubscriptionMode(
  consolidationKey: string,
  automatic: boolean
) {
  await sqlExecutor.execute(
    `
      INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic)
      VALUES (:consolidation_key, :automatic)
      ON DUPLICATE KEY UPDATE automatic = VALUES(automatic)
    `,
    {
      consolidation_key: consolidationKey,
      automatic: automatic
    }
  );
}
