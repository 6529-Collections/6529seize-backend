import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  PROFILE_FULL,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  WALLETS_CONSOLIDATION_KEYS_VIEW
} from '../../../constants';
import { sqlExecutor } from '../../../sql-executor';
import {
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionMode,
  SubscriptionTopUp
} from '../../../entities/ISubscription';
import { constructFilters } from '../api-helpers';
import { fetchPaginated } from '../../../db-api';
import { getMaxMemeId } from '../../../nftsLoop/db.nfts';
import { BadRequestException } from '../../../exceptions';
export interface SubscriptionDetails {
  consolidation_key: string;
  last_update: number;
  balance: number;
  automatic: boolean;
}

export interface NFTSubscription {
  consolidation_key: string;
  contract: string;
  token_id: number;
  subscribed: boolean;
}

async function getForConsolidationKey(consolidationKey: string, table: string) {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${table} WHERE consolidation_key = :consolidationKey`,
    { consolidationKey }
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

  const lastUpdateBalance = balance?.updated_at
    ? new Date(balance.updated_at.toString()).getTime()
    : 0;
  const lastUpdateMode = mode?.updated_at
    ? new Date(mode.updated_at.toString()).getTime()
    : 0;

  return {
    consolidation_key: consolidationKey,
    last_update: Math.max(lastUpdateBalance, lastUpdateMode),
    balance: balance?.balance ?? 0,
    automatic: !!mode?.automatic
  };
}

export async function fetchLogsForConsolidationKey(
  consolidationKey: string,
  pageSize: number,
  page: number
): Promise<{
  count: number;
  page: number;
  next: boolean;
  data: SubscriptionTopUp[];
}> {
  const filters = constructFilters('', `consolidation_key = :consolidationKey`);
  const params = { consolidationKey };

  return fetchPaginated(
    SUBSCRIPTIONS_LOGS_TABLE,
    params,
    'id desc',
    pageSize,
    page,
    filters,
    ''
  );
}

export async function fetchConsolidationWallets(
  consolidationKey: string
): Promise<string[]> {
  const consolidation = (
    await sqlExecutor.execute(
      `SELECT * FROM ${PROFILE_FULL} WHERE consolidation_key = :consolidationKey`,
      { consolidationKey: consolidationKey.toLowerCase() }
    )
  )[0];
  if (!consolidation) {
    return [];
  }
  return [consolidation.wallet1, consolidation.wallet2, consolidation.wallet3];
}

export async function updateSubscriptionMode(
  consolidationKey: string,
  automatic: boolean
) {
  if (automatic) {
    const balance = await getForConsolidationKey(
      consolidationKey,
      SUBSCRIPTIONS_BALANCES_TABLE
    );
    if (!balance || balance.balance < MEMES_MINT_PRICE) {
      throw new BadRequestException(
        `Not enough balance to set Subscription to Automatic. Need at least ${MEMES_MINT_PRICE} ETH.`
      );
    }
  }
  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      await sqlExecutor.execute(
        `
          INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic)
          VALUES (:consolidation_key, :automatic)
          ON DUPLICATE KEY UPDATE automatic = VALUES(automatic)
        `,
        {
          consolidation_key: consolidationKey,
          automatic: automatic
        },
        { wrappedConnection }
      );
      const log = `Subscription Mode set to ${
        automatic ? 'Automatic' : 'Manual'
      }`;
      await sqlExecutor.execute(
        `
          INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log)
          VALUES (:consolidationKey, :log)
        `,
        { consolidationKey, log },
        { wrappedConnection }
      );
      await updateSubscriptionsAfterModeChange(
        consolidationKey,
        automatic,
        wrappedConnection
      );
    }
  );

  return {
    consolidation_key: consolidationKey,
    automatic
  };
}

async function updateSubscriptionsAfterModeChange(
  consolidationKey: string,
  automatic: boolean,
  wrappedConnection: any
) {
  const upcomingSubscriptions = await fetchUpcomingMemeSubscriptions(
    consolidationKey
  );

  const promises: Promise<any>[] = [];

  if (!automatic) {
    upcomingSubscriptions
      .filter((e) => e.subscribed)
      .forEach((subscription) => {
        promises.push(
          sqlExecutor.execute(
            `
              DELETE FROM ${SUBSCRIPTIONS_NFTS_TABLE}
              WHERE consolidation_key = :consolidationKey
                AND contract = :contract
                AND token_id = :tokenId
            `,
            {
              consolidationKey,
              contract: subscription.contract,
              tokenId: subscription.token_id
            },
            { wrappedConnection }
          )
        );
        promises.push(
          sqlExecutor.execute(
            `
              INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log)
              VALUES (:consolidationKey, :log)
            `,
            {
              consolidationKey,
              log: `Unsubscribed from Meme #${subscription.token_id}`
            },
            { wrappedConnection }
          )
        );
      });
  } else {
    upcomingSubscriptions
      .filter((e) => !e.subscribed)
      .forEach((subscription) => {
        promises.push(
          sqlExecutor.execute(
            `
              INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id)
              VALUES (:consolidationKey, :contract, :tokenId)
            `,
            {
              consolidationKey,
              contract: subscription.contract,
              tokenId: subscription.token_id
            },
            { wrappedConnection }
          )
        );
        promises.push(
          sqlExecutor.execute(
            `
              INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log)
              VALUES (:consolidationKey, :log)
            `,
            {
              consolidationKey,
              log: `Subscribed for Meme #${subscription.token_id}`
            },
            { wrappedConnection }
          )
        );
      });
  }
  await Promise.all(promises);
}

export async function fetchUpcomingMemeSubscriptions(
  consolidationKey: string,
  completed?: boolean
): Promise<NFTSubscription[]> {
  const maxMemeId = await getMaxMemeId(completed);

  const subscriptions: NFTSubscription[] = [];
  for (let i = 1; i <= 3; i++) {
    const id = maxMemeId + i;
    const results = await sqlExecutor.execute(
      `SELECT
          *
        FROM
          ${SUBSCRIPTIONS_NFTS_TABLE}
        WHERE
          consolidation_key = :consolidationKey
          AND contract = :memesContract
          AND token_id = :id
      `,
      { consolidationKey, memesContract: MEMES_CONTRACT, id }
    );
    if (results.length === 1) {
      subscriptions.push({
        consolidation_key: results[0].consolidation_key,
        contract: results[0].contract,
        token_id: results[0].token_id,
        subscribed: true
      });
    } else {
      subscriptions.push({
        consolidation_key: consolidationKey,
        contract: MEMES_CONTRACT,
        token_id: id,
        subscribed: false
      });
    }
  }
  return subscriptions;
}

export async function updateSubscription(
  consolidationKey: string,
  contract: string,
  tokenId: number,
  subscribed: boolean
) {
  if (subscribed) {
    const balance = await getForConsolidationKey(
      consolidationKey,
      SUBSCRIPTIONS_BALANCES_TABLE
    );
    if (!balance || balance.balance < MEMES_MINT_PRICE) {
      throw new BadRequestException(
        `Not enough balance to subscribe. Need at least ${MEMES_MINT_PRICE} ETH.`
      );
    }
  }
  const maxMemeId = await getMaxMemeId();
  if (maxMemeId >= tokenId) {
    throw new BadRequestException(`Meme #${tokenId} already dropped.`);
  }

  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      let sql: string;
      let log: string;
      if (subscribed) {
        sql = `
          INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id)
          VALUES (:consolidation_key, :contract, :token_id)
        `;
        log = `Subscribed for Meme #${tokenId}`;
      } else {
        sql = `
          DELETE FROM ${SUBSCRIPTIONS_NFTS_TABLE}
          WHERE consolidation_key = :consolidation_key
            AND contract = :contract
            AND token_id = :token_id
        `;
        log = `Unsubscribed from Meme #${tokenId}`;
      }
      await sqlExecutor.execute(
        sql,
        {
          consolidation_key: consolidationKey,
          contract,
          token_id: tokenId,
          subscribed
        },
        { wrappedConnection }
      );
      await sqlExecutor.execute(
        `
          INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log)
          VALUES (:consolidationKey, :log)
        `,
        { consolidationKey, log },
        { wrappedConnection }
      );
    }
  );
  return {
    consolidation_key: consolidationKey,
    contract,
    token_id: tokenId,
    subscribed
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
      `SELECT * FROM ${WALLETS_CONSOLIDATION_KEYS_VIEW} WHERE consolidation_key = :consolidationKey`,
      { consolidationKey }
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

export async function fetchRedeemedSubscriptionsForConsolidationKey(
  consolidationKey: string,
  pageSize: number,
  page: number
): Promise<{
  count: number;
  page: number;
  next: boolean;
  data: RedeemedSubscription[];
}> {
  const filters = constructFilters('', `consolidation_key = :consolidationKey`);
  const params = { consolidationKey };

  return fetchPaginated(
    SUBSCRIPTIONS_REDEEMED_TABLE,
    params,
    'transaction_date desc',
    pageSize,
    page,
    filters
  );
}

export async function fetchSubscriptionUploads(
  contract: string,
  pageSize: number,
  page: number
) {
  let filters = '';
  let params: any = {};
  if (contract) {
    filters = constructFilters(filters, `contract = :contract`);
    params = { contract };
  }

  return fetchPaginated(
    SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
    params,
    'token_id desc',
    pageSize,
    page,
    filters
  );
}

export async function fetchFinalSubscription(
  consolidationKey: string,
  contract: string,
  tokenId: number
): Promise<NFTFinalSubscription | null> {
  const results = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} 
    WHERE 
      consolidation_key = :consolidationKey 
      AND contract = :contract 
      AND token_id = :tokenId`,
    { consolidationKey, contract, tokenId }
  );
  if (results.length === 1) {
    return results[0];
  }
  return null;
}

export async function fetchAllNftFinalSubscriptionsForContractAndToken(
  contract: string,
  token_id: number
): Promise<NFTFinalSubscription[]> {
  return sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} 
    WHERE 
      contract = :contract 
      AND token_id = :token_id
    ORDER BY subscribed_at ASC`,
    { contract, token_id }
  );
}
