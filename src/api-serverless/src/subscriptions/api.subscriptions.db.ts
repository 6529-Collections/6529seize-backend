import {
  ADDRESS_CONSOLIDATION_KEY,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_MINT_PRICE,
  NFTS_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import {
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionMode,
  SubscriptionTopUp
} from '../../../entities/ISubscription';
import { BadRequestException } from '../../../exceptions';
import { getMaxMemeId } from '../../../nftsLoop/db.nfts';
import { sqlExecutor } from '../../../sql-executor';
import { equalIgnoreCase } from '../../../strings';
import { fetchSubscriptionEligibility } from '../../../subscriptionsDaily/db.subscriptions';
import { PaginatedResponse } from '../api-constants';
import { constructFilters } from '../api-helpers';

const SUBSCRIPTIONS_START_ID = 220;

export interface SubscriptionDetails {
  consolidation_key: string;
  last_update: number;
  balance: number;
  automatic: boolean;
  subscribe_all_editions: boolean;
  subscription_eligibility_count: number;
}

export interface NFTSubscription {
  consolidation_key: string;
  contract: string;
  token_id: number;
  subscribed: boolean;
  subscribed_count: number;
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
  szn: number;
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

  const subscriptionEligibility =
    await fetchSubscriptionEligibility(consolidationKey);

  return {
    consolidation_key: consolidationKey,
    last_update: Math.max(lastUpdateBalance, lastUpdateMode),
    balance: balance?.balance ?? 0,
    automatic: !!mode?.automatic,
    subscribe_all_editions: !!mode?.subscribe_all_editions,
    subscription_eligibility_count: subscriptionEligibility
  };
}

export async function fetchLogsForConsolidationKey(
  consolidationKey: string,
  pageSize: number,
  page: number
): Promise<PaginatedResponse<SubscriptionTopUp>> {
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

export async function fetchConsolidationAddresses(
  consolidationKey: string
): Promise<string[]> {
  return (
    await sqlExecutor.execute<{ address: string }>(
      `SELECT address FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE consolidation_key = :consolidationKey`,
      { consolidationKey }
    )
  ).map((address) => address.address);
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
      automatic: automatic,
      subscribe_all_editions: false
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

export async function updateSubscribeAllEditions(
  consolidationKey: string,
  subscribe_all_editions: boolean,
  connection?: any
) {
  const mode: SubscriptionMode = await getForConsolidationKey(
    consolidationKey,
    SUBSCRIPTIONS_MODE_TABLE,
    connection
  );
  if (!mode.automatic) {
    throw new BadRequestException(
      `Subscription mode must be Automatic to update subscribe to all eligible editions.`
    );
  }

  const connectionToUse =
    connection ||
    (await sqlExecutor.executeNativeQueriesInTransaction(
      async (wrappedConnection) => wrappedConnection
    ));

  await updateSubscribeAllEditionsInternal(
    consolidationKey,
    subscribe_all_editions,
    connectionToUse
  );

  return {
    consolidation_key: consolidationKey,
    subscribe_all_editions
  };
}

async function updateSubscribeAllEditionsInternal(
  consolidationKey: string,
  subscribe_all_editions: boolean,
  wrappedConnection?: any
) {
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, subscribe_all_editions) VALUES (:consolidation_key, :subscribe_all_editions) ON DUPLICATE KEY UPDATE subscribe_all_editions = VALUES(subscribe_all_editions)`,
    { consolidationKey, subscribe_all_editions },
    { wrappedConnection }
  );

  await updateSubscriptionsAfterSubscribeAllEditionsChange(
    consolidationKey,
    subscribe_all_editions,
    wrappedConnection
  );
}

async function updateSubscriptionsAfterSubscribeAllEditionsChange(
  consolidationKey: string,
  subscribe_all_editions: boolean,
  wrappedConnection: any
) {
  let subscribedCount = 1;
  if (subscribe_all_editions) {
    const subscriptionEligibility =
      await fetchSubscriptionEligibility(consolidationKey);
    subscribedCount = subscriptionEligibility;
  }
  const promises: Promise<any>[] = [];
  const maxMemeId = await getMaxMemeId();
  const upcomingSubscriptions: NFTSubscription[] = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE consolidation_key = :consolidationKey AND contract = :memesContract AND token_id > :maxMemeId AND subscribed = :subscribed`,
    {
      consolidationKey,
      memesContract: MEMES_CONTRACT,
      maxMemeId,
      subscribed: true
    },
    { wrappedConnection }
  );

  const logLine = subscribe_all_editions
    ? 'Subscribed to all eligible editions'
    : 'Subscribed to a one edition';

  upcomingSubscriptions.forEach((subscription) => {
    promises.push(
      sqlExecutor.execute(
        `
        INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id, subscribed)
        VALUES (:consolidationKey, :contract, :tokenId, :subscribedCount)
        ON DUPLICATE KEY UPDATE subscribed = VALUES(subscribed)
        `,
        {
          consolidationKey,
          contract: subscription.contract,
          tokenId: subscription.token_id,
          subscribedCount
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
  const subscriptionEligibility =
    await fetchSubscriptionEligibility(consolidationKey);
  for (let i = 1; i <= cardCount; i++) {
    const id = maxMemeId + i;
    const sub = results.find((r) => r.token_id === id);
    if (sub) {
      subscriptions.push({
        consolidation_key: sub.consolidation_key,
        contract: sub.contract,
        token_id: sub.token_id,
        subscribed: sub.subscribed,
        subscribed_count: sub.subscribed_count
      });
    } else {
      subscriptions.push({
        consolidation_key: consolidationKey,
        contract: MEMES_CONTRACT,
        token_id: id,
        subscribed: mode?.automatic ?? false,
        subscribed_count: mode?.automatic ? subscriptionEligibility : 1
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
): Promise<PaginatedResponse<SubscriptionTopUp>> {
  let wallets = await fetchConsolidationAddresses(consolidationKey);
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
): Promise<PaginatedResponse<RedeemedSubscription>> {
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
          equalIgnoreCase(ts.consolidation_key, s.consolidation_key)
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

export async function fetchPastMemeSubscriptionCounts(
  pageSize?: string,
  page?: string
): Promise<
  RedeemedSubscriptionCounts[] | PaginatedResponse<RedeemedSubscriptionCounts>
> {
  if (pageSize && page) {
    const pageSizeNumber = parseInt(pageSize);
    const pageNumber = parseInt(page);

    const joins = `
      LEFT JOIN ${SUBSCRIPTIONS_REDEEMED_TABLE} 
        ON ${SUBSCRIPTIONS_REDEEMED_TABLE}.contract = ${NFTS_TABLE}.contract 
        AND ${SUBSCRIPTIONS_REDEEMED_TABLE}.token_id = ${NFTS_TABLE}.id 
      LEFT JOIN ${MEMES_EXTENDED_DATA_TABLE}
        ON ${MEMES_EXTENDED_DATA_TABLE}.id = ${NFTS_TABLE}.id
    `;

    const fields = `
      ${NFTS_TABLE}.contract,
      ${NFTS_TABLE}.id AS token_id,
      COALESCE(COUNT(${SUBSCRIPTIONS_REDEEMED_TABLE}.consolidation_key), 0) AS count,
      ${NFTS_TABLE}.name AS name,
      ${NFTS_TABLE}.thumbnail AS image_url,
      ${NFTS_TABLE}.mint_date AS mint_date,
      ${MEMES_EXTENDED_DATA_TABLE}.season AS szn
    `;

    const groupBy = `${NFTS_TABLE}.contract, ${NFTS_TABLE}.id`;
    const orderBy = `${NFTS_TABLE}.id DESC`;

    const filters = constructFilters(
      'id',
      `${NFTS_TABLE}.id >= :startId AND ${NFTS_TABLE}.contract = :contract`
    );

    return fetchPaginated<RedeemedSubscriptionCounts>(
      NFTS_TABLE,
      { startId: SUBSCRIPTIONS_START_ID, contract: MEMES_CONTRACT },
      orderBy,
      pageSizeNumber,
      pageNumber,
      filters,
      fields,
      joins,
      groupBy,
      { skipJoinsOnCountQuery: false }
    );
  } else {
    return sqlExecutor.execute(
      `SELECT 
        ${NFTS_TABLE}.contract, 
        ${NFTS_TABLE}.id AS token_id, 
        COALESCE(COUNT(${SUBSCRIPTIONS_REDEEMED_TABLE}.consolidation_key), 0) AS count,
        ${NFTS_TABLE}.name AS name,
        ${NFTS_TABLE}.thumbnail AS image_url,
        ${NFTS_TABLE}.mint_date AS mint_date,
        ${MEMES_EXTENDED_DATA_TABLE}.season AS szn
      FROM ${NFTS_TABLE}
      LEFT JOIN ${SUBSCRIPTIONS_REDEEMED_TABLE} 
        ON ${SUBSCRIPTIONS_REDEEMED_TABLE}.contract = ${NFTS_TABLE}.contract 
        AND ${SUBSCRIPTIONS_REDEEMED_TABLE}.token_id = ${NFTS_TABLE}.id
      LEFT JOIN ${MEMES_EXTENDED_DATA_TABLE}
        ON ${MEMES_EXTENDED_DATA_TABLE}.id = ${NFTS_TABLE}.id
      WHERE ${NFTS_TABLE}.id >= ${SUBSCRIPTIONS_START_ID}
        AND ${NFTS_TABLE}.contract = '${MEMES_CONTRACT}'
      GROUP BY ${NFTS_TABLE}.contract, ${NFTS_TABLE}.id
      ORDER BY ${NFTS_TABLE}.id DESC`
    );
  }
}
