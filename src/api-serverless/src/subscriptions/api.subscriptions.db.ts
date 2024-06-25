import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NFTS_TABLE,
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
import { areEqualAddresses } from '../../../helpers';

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

export interface SubscriptionCounts {
  contract: string;
  token_id: number;
  count: number;
}

export interface RedeemedSubscriptionCounts extends SubscriptionCounts {
  name: string;
  image_url: string;
  mint_date: string;
}

async function getForConsolidationKey(
  consolidationKey: string,
  table: string,
  wrappedConnection?: any
) {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${table} WHERE consolidation_key = :consolidationKey`,
    { consolidationKey },
    { wrappedConnection }
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
  const wallets: string[] = (
    await sqlExecutor.execute(
      `SELECT * FROM ${WALLETS_CONSOLIDATION_KEYS_VIEW} WHERE consolidation_key = :consolidationKey`,
      { consolidationKey }
    )
  ).map((wallet: any) => wallet.wallet);
  return wallets;
}

export async function updateSubscriptionMode(
  consolidationKey: string,
  automatic: boolean,
  connection?: any
) {
  if (automatic) {
    const balance = await getForConsolidationKey(
      consolidationKey,
      SUBSCRIPTIONS_BALANCES_TABLE,
      connection
    );

    if (!balance || balance.balance < MEMES_MINT_PRICE) {
      throw new BadRequestException(
        `Not enough balance to set Subscription to Automatic. Need at least ${MEMES_MINT_PRICE} ETH.`
      );
    }
  }

  const connectionToUse =
    connection ||
    (await sqlExecutor.executeNativeQueriesInTransaction(
      async (wrappedConnection) => wrappedConnection
    ));

  await updateSubscriptionModeInternal(
    consolidationKey,
    automatic,
    connectionToUse
  );

  return {
    consolidation_key: consolidationKey,
    automatic
  };
}

async function updateSubscriptionModeInternal(
  consolidationKey: string,
  automatic: boolean,
  wrappedConnection?: any
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
    },
    { wrappedConnection }
  );
  const log = `Subscription Mode set to ${automatic ? 'Automatic' : 'Manual'}`;
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

async function updateSubscriptionsAfterModeChange(
  consolidationKey: string,
  automatic: boolean,
  wrappedConnection: any
) {
  const promises: Promise<any>[] = [];
  const maxMemeId = await getMaxMemeId();
  const upcomingSubscriptions: NFTSubscription[] = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE consolidation_key = :consolidationKey AND contract = :memesContract AND token_id > :maxMemeId AND subscribed = :subscribed`,
    {
      consolidationKey,
      memesContract: MEMES_CONTRACT,
      maxMemeId,
      subscribed: !automatic
    },
    { wrappedConnection }
  );

  const logLine = automatic ? 'Subscribed to' : 'Unsubscribed from';

  upcomingSubscriptions.forEach((subscription) => {
    promises.push(
      sqlExecutor.execute(
        `
        INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id, subscribed)
        VALUES (:consolidationKey, :contract, :tokenId, :subscribed)
        ON DUPLICATE KEY UPDATE subscribed = VALUES(subscribed)
        `,
        {
          consolidationKey,
          contract: subscription.contract,
          tokenId: subscription.token_id,
          subscribed: automatic
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
          log: `${logLine} Meme #${subscription.token_id}`
        },
        { wrappedConnection }
      )
    );
  });
  await Promise.all(promises);
}

export async function fetchUpcomingMemeSubscriptions(
  consolidationKey: string,
  cardCount: number
): Promise<NFTSubscription[]> {
  const maxMemeId = await getMaxMemeId(true);

  const mode: SubscriptionMode = await getForConsolidationKey(
    consolidationKey,
    SUBSCRIPTIONS_MODE_TABLE
  );

  const results: NFTSubscription[] = await sqlExecutor.execute(
    `SELECT
          *
        FROM
          ${SUBSCRIPTIONS_NFTS_TABLE}
        WHERE
          consolidation_key = :consolidationKey
          AND contract = :memesContract
          AND token_id > :maxMemeId
      `,
    { consolidationKey, memesContract: MEMES_CONTRACT, maxMemeId }
  );

  const subscriptions: NFTSubscription[] = [];
  for (let i = 1; i <= cardCount; i++) {
    const id = maxMemeId + i;
    const sub = results.find((r) => r.token_id === id);
    if (sub) {
      subscriptions.push({
        consolidation_key: sub.consolidation_key,
        contract: sub.contract,
        token_id: sub.token_id,
        subscribed: sub.subscribed
      });
    } else {
      subscriptions.push({
        consolidation_key: consolidationKey,
        contract: MEMES_CONTRACT,
        token_id: id,
        subscribed: mode?.automatic ?? false
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
      let log: string;
      if (subscribed) {
        log = `Subscribed for Meme #${tokenId}`;
      } else {
        log = `Unsubscribed from Meme #${tokenId}`;
      }

      await sqlExecutor.execute(
        `
        INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id, subscribed)
        VALUES (:consolidation_key, :contract, :token_id, :subscribed)
        ON DUPLICATE KEY UPDATE subscribed = VALUES(subscribed)
        `,
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
  let wallets = await fetchConsolidationWallets(consolidationKey);
  if (wallets.length === 0) {
    wallets = [consolidationKey];
  }
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

export async function fetchAllPublicFinalSubscriptionsForContractAndToken(
  contract: string,
  token_id: number
): Promise<NFTFinalSubscription[]> {
  return sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} 
    WHERE 
      contract = :contract 
      AND token_id = :token_id
      AND phase IS NULL
    ORDER BY subscribed_at ASC`,
    { contract, token_id }
  );
}

export async function fetchUpcomingMemeSubscriptionCounts(
  cardCount: number
): Promise<SubscriptionCounts[]> {
  const autoSubs: SubscriptionMode[] = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_MODE_TABLE} WHERE automatic = :automatic`,
    { automatic: true }
  );

  const maxMemeId = await getMaxMemeId();

  const subs: NFTSubscription[] = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE token_id > :startIndex AND token_id <= :endIndex`,
    {
      startIndex: maxMemeId,
      endIndex: maxMemeId + cardCount
    }
  );

  const counts: SubscriptionCounts[] = [];
  for (let i = 1; i <= cardCount; i++) {
    const id = maxMemeId + i;
    const tokenSubs = [...subs].filter((s) => s.token_id === id);
    const tokenAutoSubs = [...autoSubs].filter(
      (s) =>
        !tokenSubs.some((ts) =>
          areEqualAddresses(ts.consolidation_key, s.consolidation_key)
        )
    );
    counts.push({
      contract: MEMES_CONTRACT,
      token_id: id,
      count: tokenSubs.filter((s) => s.subscribed).length + tokenAutoSubs.length
    });
  }
  return counts;
}

export async function fetchPastMemeSubscriptionCounts(): Promise<
  RedeemedSubscriptionCounts[]
> {
  return sqlExecutor.execute(
    `SELECT 
      ${SUBSCRIPTIONS_REDEEMED_TABLE}.contract, 
      ${SUBSCRIPTIONS_REDEEMED_TABLE}.token_id, 
      count(*) as count,
      ${NFTS_TABLE}.name as name,
      ${NFTS_TABLE}.thumbnail as image_url,
      ${NFTS_TABLE}.mint_date as mint_date
    FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} 
    LEFT JOIN ${NFTS_TABLE} ON ${SUBSCRIPTIONS_REDEEMED_TABLE}.contract = ${NFTS_TABLE}.contract AND ${SUBSCRIPTIONS_REDEEMED_TABLE}.token_id = ${NFTS_TABLE}.id
    GROUP BY contract, token_id 
    ORDER BY token_id DESC;`
  );
}
