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
} from '@/constants';
import { fetchNft, fetchPaginated } from '../../../db-api';
import {
  SubscriptionBalance,
  SubscriptionMode
} from '../../../entities/ISubscription';
import { BadRequestException } from '../../../exceptions';
import { getMaxMemeId } from '../../../nftsLoop/db.nfts';
import { sqlExecutor } from '../../../sql-executor';
import { equalIgnoreCase } from '../../../strings';
import { fetchSubscriptionEligibility } from '../../../subscriptionsDaily/db.subscriptions';
import { Time } from '../../../time';
import { PaginatedResponse } from '../api-constants';
import { constructFilters } from '../api-helpers';
import { NFTFinalSubscription } from '../generated/models/NFTFinalSubscription';
import { NFTSubscription } from '../generated/models/NFTSubscription';
import { PhaseAirdrop } from '../generated/models/PhaseAirdrop';
import { RedeemedSubscription } from '../generated/models/RedeemedSubscription';
import { RedeemedSubscriptionCounts } from '../generated/models/RedeemedSubscriptionCounts';
import { SubscriptionCounts } from '../generated/models/SubscriptionCounts';
import { SubscriptionDetails } from '../generated/models/SubscriptionDetails';
import { SubscriptionTopUp } from '../generated/models/SubscriptionTopUp';

const SUBSCRIPTIONS_START_ID = 220;

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

  let lastUpdate = 0;
  if (mode?.automatic && mode.updated_at) {
    lastUpdate = new Date(mode.updated_at.toString()).getTime();
  }

  const subscriptionEligibility =
    await fetchSubscriptionEligibility(consolidationKey);

  return {
    consolidation_key: consolidationKey,
    last_update: lastUpdate,
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

async function getEffectiveMaxMemeId(): Promise<number> {
  let maxMemeId = await getMaxMemeId();
  if (Time.isMemeDropDay()) {
    const lastMinted = await fetchNft(MEMES_CONTRACT, maxMemeId);
    const lastMintedDate = lastMinted?.mint_date
      ? Time.fromDate(new Date(lastMinted.mint_date))
      : Time.now();
    if (lastMinted && !lastMintedDate.isToday()) {
      maxMemeId++;
    }
  }
  return maxMemeId;
}

async function updateSubscriptionsAfterModeChange(
  consolidationKey: string,
  automatic: boolean,
  wrappedConnection: any
) {
  const promises: Promise<any>[] = [];
  const maxMemeId = await getEffectiveMaxMemeId();
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
  consolidation_key: string,
  subscribe_all_editions: boolean,
  wrappedConnection?: any
) {
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} 
      (consolidation_key, subscribe_all_editions) 
      VALUES (:consolidation_key, :subscribe_all_editions)
      ON DUPLICATE KEY UPDATE 
        subscribe_all_editions = VALUES(subscribe_all_editions)`,
    {
      consolidation_key,
      subscribe_all_editions
    },
    { wrappedConnection }
  );

  const log = `Edition preference set to ${subscribe_all_editions ? 'All eligible editions' : 'One edition'}`;
  await sqlExecutor.execute(
    `
      INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log)
      VALUES (:consolidation_key, :log)
    `,
    { consolidation_key, log },
    { wrappedConnection }
  );
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
        subscribed_count: mode?.subscribe_all_editions
          ? subscriptionEligibility
          : 1
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

  const mode = await fetchSubscriptionModeForConsolidationKey(consolidationKey);
  let subscribedCount = 1;
  const subscriptionEligibility =
    await fetchSubscriptionEligibility(consolidationKey);
  if (mode?.subscribe_all_editions) {
    subscribedCount = subscriptionEligibility;
  }

  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      let log: string;
      let additionalInfo: string = '';
      if (subscribed) {
        log = `Subscribed for Meme #${tokenId}`;
        additionalInfo = `Edition Preference: ${mode?.subscribe_all_editions ? 'All eligible' : 'One edition'} - Eligibility: x${subscriptionEligibility} - Subscription Count: x${subscribedCount}`;
      } else {
        log = `Unsubscribed from Meme #${tokenId}`;
      }

      await sqlExecutor.execute(
        `
        INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id, subscribed, subscribed_count)
        VALUES (:consolidation_key, :contract, :token_id, :subscribed, :subscribed_count)
        ON DUPLICATE KEY UPDATE subscribed = VALUES(subscribed), subscribed_count = VALUES(subscribed_count)
        `,
        {
          consolidation_key: consolidationKey,
          contract,
          token_id: tokenId,
          subscribed,
          subscribed_count: subscribedCount
        },
        { wrappedConnection }
      );
      await sqlExecutor.execute(
        `
          INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log, additional_info)
          VALUES (:consolidationKey, :log, :additionalInfo)
        `,
        { consolidationKey, log, additionalInfo },
        { wrappedConnection }
      );
    }
  );

  return {
    consolidation_key: consolidationKey,
    contract,
    token_id: tokenId,
    subscribed,
    subscribed_count: subscribedCount
  };
}

export async function updateSubscriptionCount(
  consolidationKey: string,
  contract: string,
  tokenId: number,
  count: number
) {
  const subscription = await fetchSubscriptionForConsolidationKey(
    consolidationKey,
    contract,
    tokenId
  );
  if (subscription && !subscription.subscribed) {
    throw new BadRequestException(
      `You are not currently subscribed for Meme #${tokenId}`
    );
  }

  const subscriptionEligibility =
    await fetchSubscriptionEligibility(consolidationKey);

  if (count > subscriptionEligibility) {
    throw new BadRequestException(
      `Eligibility count for Meme #${tokenId} is ${subscriptionEligibility}. You cannot increase the subscription count beyond this limit.`
    );
  }

  const balance = await getForConsolidationKey(
    consolidationKey,
    SUBSCRIPTIONS_BALANCES_TABLE
  );
  const requiredBalance = count * MEMES_MINT_PRICE;
  if (!balance || balance.balance < requiredBalance) {
    throw new BadRequestException(
      `Not enough balance to subscribe for ${count} editions. Need at least ${requiredBalance} ETH.`
    );
  }

  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      const log = `Updated subscription count for Meme #${tokenId} to x${count}`;
      const additionalInfo = `Eligibility: x${subscriptionEligibility}`;

      await sqlExecutor.execute(
        `
          INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id, subscribed_count)
          VALUES (:consolidation_key, :contract, :token_id, :subscribed_count)
          ON DUPLICATE KEY UPDATE subscribed_count = VALUES(subscribed_count)
        `,
        {
          consolidation_key: consolidationKey,
          contract,
          token_id: tokenId,
          subscribed_count: count
        },
        { wrappedConnection }
      );
      await sqlExecutor.execute(
        `
          INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log, additional_info)
          VALUES (:consolidationKey, :log, :additionalInfo)
        `,
        { consolidationKey, log, additionalInfo },
        { wrappedConnection }
      );
    }
  );

  return {
    consolidation_key: consolidationKey,
    contract,
    token_id: tokenId,
    count
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

export async function fetchFinalSubscriptionsByPhase(
  contract: string,
  tokenId: number,
  phaseName: string
): Promise<PhaseAirdrop[]> {
  return sqlExecutor.execute<PhaseAirdrop>(
    `SELECT airdrop_address as wallet, subscribed_count as amount
     FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
     WHERE contract = :contract
       AND token_id = :tokenId
       AND phase = :phaseName
     ORDER BY phase_position ASC`,
    { contract, tokenId, phaseName }
  );
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

  // Fetch all subscription records (both subscribed = true and false)
  // to check if someone manually unsubscribed from a specific card
  const subs: NFTSubscription[] = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE token_id > :startIndex AND token_id <= :endIndex`,
    {
      startIndex: maxMemeId,
      endIndex: maxMemeId + cardCount
    }
  );

  // Get all unique consolidation keys from subscriptions and auto subscriptions
  const allConsolidationKeys = new Set<string>();
  subs.forEach((s) => allConsolidationKeys.add(s.consolidation_key));
  autoSubs.forEach((s) => allConsolidationKeys.add(s.consolidation_key));

  // Fetch all balances for these consolidation keys
  const balances: SubscriptionBalance[] =
    allConsolidationKeys.size > 0
      ? await sqlExecutor.execute(
          `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE} WHERE consolidation_key IN (:consolidationKeys)`,
          { consolidationKeys: Array.from(allConsolidationKeys) }
        )
      : [];

  // Create a map for quick balance lookup
  const balanceMap = new Map<string, number>();
  balances.forEach((b) => {
    balanceMap.set(b.consolidation_key.toLowerCase(), b.balance);
  });

  // Fetch subscription eligibility for auto subscriptions
  const autoSubEligibilityMap = new Map<string, number>();
  await Promise.all(
    autoSubs.map(async (autoSub) => {
      const eligibility = await fetchSubscriptionEligibility(
        autoSub.consolidation_key
      );
      autoSubEligibilityMap.set(
        autoSub.consolidation_key.toLowerCase(),
        eligibility
      );
    })
  );

  const counts: SubscriptionCounts[] = [];
  for (let i = 1; i <= cardCount; i++) {
    const id = maxMemeId + i;
    // Get all manual subscription records for this token (both subscribed = true and false)
    const allTokenSubs = [...subs].filter((s) => s.token_id === id);
    // Only count manual subscriptions where subscribed = true
    const tokenSubs = allTokenSubs.filter((s) => s.subscribed);
    // For auto subscriptions, only count if they don't have ANY manual record for this token
    // (if they have a manual record with subscribed = false, they manually unsubscribed)
    const tokenAutoSubs = [...autoSubs].filter(
      (s) =>
        !allTokenSubs.some((ts) =>
          equalIgnoreCase(ts.consolidation_key, s.consolidation_key)
        )
    );

    let totalCount = 0;

    // Calculate effective count for manual subscriptions (only those with subscribed = true)
    for (const sub of tokenSubs) {
      const balance = balanceMap.get(sub.consolidation_key.toLowerCase()) ?? 0;
      const affordableCount = Math.floor(balance / MEMES_MINT_PRICE);
      const effectiveCount = Math.min(
        sub.subscribed_count ?? 1,
        Math.max(0, affordableCount)
      );
      totalCount += effectiveCount;
    }

    // Calculate effective count for auto subscriptions
    // (only those without any manual subscription record for this token)
    for (const autoSub of tokenAutoSubs) {
      const balance =
        balanceMap.get(autoSub.consolidation_key.toLowerCase()) ?? 0;
      const eligibility =
        autoSubEligibilityMap.get(autoSub.consolidation_key.toLowerCase()) ?? 1;
      const subscribedCount = autoSub.subscribe_all_editions ? eligibility : 1;
      const affordableCount = Math.floor(balance / MEMES_MINT_PRICE);
      const effectiveCount = Math.min(
        subscribedCount,
        Math.max(0, affordableCount)
      );
      totalCount += effectiveCount;
    }

    counts.push({
      contract: MEMES_CONTRACT,
      token_id: id,
      count: totalCount
    });
  }
  return counts;
}

export async function fetchPastMemeSubscriptionCounts(
  pageSize: number,
  page: number
): Promise<PaginatedResponse<RedeemedSubscriptionCounts>> {
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
    pageSize,
    page,
    filters,
    fields,
    joins,
    groupBy,
    { skipJoinsOnCountQuery: false }
  );
}

async function fetchSubscriptionModeForConsolidationKey(
  consolidationKey: string
): Promise<SubscriptionMode | undefined> {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_MODE_TABLE} WHERE consolidation_key = :consolidationKey`,
    { consolidationKey }
  );
  if (result.length === 1) {
    return result[0];
  }
  return undefined;
}

async function fetchSubscriptionForConsolidationKey(
  consolidationKey: string,
  contract: string,
  tokenId: number
): Promise<NFTSubscription | undefined> {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE consolidation_key = :consolidationKey AND contract = :contract AND token_id = :tokenId`,
    { consolidationKey, contract, tokenId }
  );
  if (result.length === 1) {
    return result[0];
  }
  return undefined;
}
