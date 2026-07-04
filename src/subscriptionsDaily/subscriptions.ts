import { json2csv } from 'json-2-csv';
import { arweaveFileUploader } from '../arweave';
import { collections } from '../collections';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import {
  fetchAllProfiles,
  fetchWalletConsolidationKeysViewForWallet,
  getDataSource
} from '../db';
import { fetchAirdropAddressForConsolidationKey } from '../delegationsLoop/db.delegations';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTFinalSubscriptionUploadFields,
  NFTSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { Logger } from '../logging';
import { getMaxMemeId } from '../nftsLoop/db.nfts';
import { sendDiscordUpdate } from '../notifier-discord';
import { sqlExecutor } from '../sql-executor';
import { equalIgnoreCase } from '../strings';
import { Time } from '../time';
import {
  fetchAllAutoSubscriptions,
  fetchAllNftSubscriptionBalances,
  fetchAllNftSubscriptions,
  fetchSubscriptionEligibility,
  persistNFTFinalSubscriptions,
  persistSubscriptions
} from './db.subscriptions';

const logger = Logger.get('SUBSCRIPTIONS');

export async function updateSubscriptions() {
  const autoSubscriptions = await fetchAllAutoSubscriptions();
  logger.info(`[FOUND ${autoSubscriptions.length} AUTO SUBSCRIPTIONS]`);

  const maxMemeId = await getMaxMemeId();
  const nextMemeId = maxMemeId + 1;

  logger.info(`[MAX CURRENT MEME ${maxMemeId}]`);

  await populateAutoSubscriptionsForMemeId(nextMemeId, autoSubscriptions);

  const uploadLink = await buildFinalSubscription(
    nextMemeId,
    autoSubscriptions
  );

  const seizeDomain =
    process.env.NODE_ENV === 'development' ? 'staging.6529' : '6529';
  let discordMessage = `📋 Published provisional list of Subscriptions for The Memes Card #${nextMemeId}`;
  discordMessage += ` \n\n[View on 6529.io] \nhttps://${seizeDomain}.io/open-data/meme-subscriptions`;
  discordMessage += ` \n\n[View on Arweave] \n${uploadLink}`;
  await sendDiscordUpdate(
    process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
    discordMessage,
    'Subscriptions',
    'info'
  );
}

async function populateAutoSubscriptionsForMemeId(
  newMeme: number,
  autoSubscriptions: SubscriptionMode[]
) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );
  logger.info(
    `[NEW MEME ID ${newMeme}] : [SUBSCRIPTIONS ${newMemeSubscriptions.length}]`
  );

  const autoSubscriptionsDelta = autoSubscriptions.filter(
    (s) =>
      !newMemeSubscriptions.some((n) =>
        equalIgnoreCase(n.consolidation_key, s.consolidation_key)
      )
  );

  if (autoSubscriptionsDelta.length === 0) {
    logger.info(`[NO AUTO SUBSCRIPTIONS TO ADD...SKIPPING]`);
  } else {
    logger.info(
      `[FOUND ${autoSubscriptionsDelta.length} AUTO SUBSCRIPTIONS FOR NEW MEME]`
    );

    const newSubscriptions: NFTSubscription[] = [];
    const newSubscriptionLogs: SubscriptionLog[] = [];

    await Promise.all(
      autoSubscriptionsDelta.map(async (s) => {
        let subscribedCount = 1;
        const eligibilityCount = await fetchSubscriptionEligibility(
          s.consolidation_key
        );
        if (s.subscribe_all_editions) {
          subscribedCount = eligibilityCount;
        }
        const sub: NFTSubscription = {
          consolidation_key: s.consolidation_key,
          contract: MEMES_CONTRACT,
          token_id: newMeme,
          subscribed: true,
          subscribed_count: subscribedCount,
          automatic_subscription: true
        };
        newSubscriptions.push(sub);
        const logText = `Auto-Subscribed to Meme #${newMeme}`;
        const additionalInfo = `Edition Preference: ${s.subscribe_all_editions ? 'All eligible' : 'One edition'} - Eligibility: x${eligibilityCount} - Subscription Count: x${subscribedCount}`;
        newSubscriptionLogs.push({
          consolidation_key: s.consolidation_key,
          log: logText,
          additional_info: additionalInfo
        });
      })
    );
    await persistSubscriptions(newSubscriptions, newSubscriptionLogs);
    logger.info(
      `[NEW MEME ID ${newMeme}] : [CREATED ${newSubscriptions.length} AUTO SUBSCRIPTIONS]`
    );
  }
}

async function buildFinalSubscription(
  newMeme: number,
  autoSubscriptions: SubscriptionMode[]
): Promise<string> {
  logger.info(`[BUILDING FINAL SUBSCRIPTION FOR MEME #${newMeme}]`);

  const now = Time.now();
  const dateStr = now.toIsoDateString();

  const { finalSubscriptions, newSubscriptionLogs } =
    await createFinalSubscriptions(newMeme, dateStr, autoSubscriptions);

  const upload: NFTFinalSubscriptionUpload = await uploadFinalSubscriptions(
    MEMES_CONTRACT,
    newMeme,
    finalSubscriptions
  );

  await persistNFTFinalSubscriptions(
    MEMES_CONTRACT,
    newMeme,
    upload,
    finalSubscriptions,
    newSubscriptionLogs
  );

  return upload.upload_url;
}

async function createFinalSubscriptions(
  newMeme: number,
  dateStr: string,
  autoSubscriptions: SubscriptionMode[]
) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );

  const filteredSubscriptions = newMemeSubscriptions.filter(
    (sub) => sub.subscribed
  );

  logger.info(
    `[DATE ${dateStr}] : [BUILDING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${filteredSubscriptions.length} SUBSCRIPTIONS]`
  );

  const balances = await fetchAllNftSubscriptionBalances();
  const newSubscriptionLogs: SubscriptionLog[] = [];
  const finalSubscriptions: NFTFinalSubscription[] = [];

  const subscriptionPromises = filteredSubscriptions.map(async (sub) => {
    const balance = balances.find((b) =>
      equalIgnoreCase(b.consolidation_key, sub.consolidation_key)
    );

    const airdropAddress = await fetchAirdropAddressForConsolidationKey(
      sub.consolidation_key
    );

    const autoSub = autoSubscriptions.find((a) =>
      equalIgnoreCase(a.consolidation_key, sub.consolidation_key)
    );

    if (balance) {
      if (balance.balance >= MEMES_MINT_PRICE) {
        let createdAt = sub.updated_at?.getTime() ?? Time.now().toMillis();
        if (autoSub) {
          createdAt = autoSub.updated_at?.getTime() ?? Time.now().toMillis();
        }
        const subscribedAt = Time.millis(createdAt).toIsoString();
        const eligibilityCount = await fetchSubscriptionEligibility(
          sub.consolidation_key
        );
        const affordableCount = Math.floor(balance.balance / MEMES_MINT_PRICE);
        const requestedCount = resolveRequestedSubscriptionCount(
          sub,
          autoSub,
          eligibilityCount
        );
        const subscribedCount = Math.min(
          eligibilityCount,
          requestedCount,
          affordableCount
        );
        if (affordableCount < requestedCount) {
          logger.info(
            `[CAPPED BY BALANCE] ${sub.consolidation_key} requested x${requestedCount}, affordable x${affordableCount}, final x${subscribedCount}`
          );
        }
        const finalSub: NFTFinalSubscription = {
          subscribed_at: subscribedAt,
          consolidation_key: sub.consolidation_key,
          contract: sub.contract,
          token_id: sub.token_id,
          subscribed_count: subscribedCount,
          airdrop_address: airdropAddress.airdrop_address,
          balance: balance.balance,
          phase: null,
          phase_subscriptions: -1,
          phase_position: -1,
          redeemed_count: 0
        };
        finalSubscriptions.push(finalSub);
        const logText = `Added to Final Subscription for Meme #${newMeme} on ${dateStr}`;
        const additionalInfo = `Airdrop Address: ${finalSub.airdrop_address} - Subscription Count: x${subscribedCount} - Balance: ${finalSub.balance} ETH`;

        newSubscriptionLogs.push({
          consolidation_key: sub.consolidation_key,
          log: logText,
          additional_info: additionalInfo
        });
      } else {
        logger.info(
          `[INSUFFICIENT BALANCE FOR ${sub.consolidation_key}] : [SKIPPING]`
        );
        if (autoSub) {
          autoSub.updated_at = new Date();
          await getDataSource().getRepository(SubscriptionMode).save(autoSub);
        }
        newSubscriptionLogs.push({
          consolidation_key: sub.consolidation_key,
          log: `Insufficient Balance for Meme #${newMeme} on ${dateStr} - Not Added to Final Subscription`,
          additional_info: `Balance: ${balance.balance} ETH`
        });
      }
    } else {
      logger.info(`[NO BALANCE FOR ${sub.consolidation_key}] : [SKIPPING]`);
      newSubscriptionLogs.push({
        consolidation_key: sub.consolidation_key,
        log: `No Balance for Meme #${newMeme} on ${dateStr}`
      });
    }
  });

  await Promise.all(subscriptionPromises);

  finalSubscriptions.sort((a, d) => {
    // order subscriptions by created_at asc and then by balance
    if (a.subscribed_at === d.subscribed_at) {
      return d.balance - a.balance;
    }
    return a.subscribed_at < d.subscribed_at ? -1 : 1;
  });

  return { finalSubscriptions, newSubscriptionLogs };
}

export function resolveRequestedSubscriptionCount(
  subscription: Pick<
    NFTSubscription,
    'subscribed_count' | 'automatic_subscription'
  >,
  autoSubscription:
    | Pick<SubscriptionMode, 'subscribe_all_editions'>
    | undefined,
  eligibilityCount: number
): number {
  if (
    autoSubscription?.subscribe_all_editions &&
    subscription.automatic_subscription
  ) {
    return eligibilityCount;
  }

  return subscription.subscribed_count;
}

async function uploadFinalSubscriptions(
  contract: string,
  newMeme: number,
  finalSubscriptions: NFTFinalSubscription[]
): Promise<NFTFinalSubscriptionUpload> {
  logger.info(
    `[UPLOADING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${finalSubscriptions.length} SUBSCRIPTIONS]`
  );
  const profiles = await fetchAllProfiles();
  const finalUpload: NFTFinalSubscriptionUploadFields[] =
    finalSubscriptions.map((sub) => {
      const profile = profiles.find((p) =>
        sub.consolidation_key
          .split('-')
          .some((key) => equalIgnoreCase(p.primary_wallet, key))
      );
      return {
        date: Time.now().toIsoDateString(),
        contract: contract,
        token_id: newMeme,
        count: sub.subscribed_count,
        profile: profile?.handle ?? '-',
        airdrop_address: sub.airdrop_address,
        consolidation_key: sub.consolidation_key,
        balance: sub.balance,
        subscribed_at: sub.subscribed_at
      };
    });
  const csv = json2csv(finalUpload);
  const { url } = await arweaveFileUploader.uploadFile(
    Buffer.from(csv),
    'text/csv'
  );

  return {
    date: Time.now().toIsoDateString(),
    contract: contract,
    token_id: newMeme,
    upload_url: url
  };
}

const CONSOLIDATION_LOOKUP_CHUNK_SIZE = 5000;

export async function consolidateSubscriptions(addresses: Set<string>) {
  const addressList = Array.from(addresses);
  const addressesFilter = addressList
    .map(
      (_, i) =>
        `${SUBSCRIPTIONS_BALANCES_TABLE}.consolidation_key LIKE :addressPattern${i}`
    )
    .join(' OR ');
  const addressesFilterParams = addressList.reduce(
    (acc, address, i) => {
      acc[`addressPattern${i}`] = `%${address}%`;
      return acc;
    },
    {} as Record<string, string>
  );

  const affectedSubscriptions: SubscriptionBalance[] =
    await sqlExecutor.execute(
      `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
    WHERE (${addressesFilter})`,
      addressesFilterParams
    );

  logger.info(
    `[CONSOLIDATING SUBSCRIPTIONS] : [FOUND ${affectedSubscriptions.length} AFFECTED SUBSCRIPTIONS]`
  );

  // prefetch view keys for every wallet part and TDH for every candidate key,
  // instead of querying per wallet part inside the loop below
  const allWalletParts = new Set<string>();
  affectedSubscriptions.forEach((sub) => {
    sub.consolidation_key.split('-').forEach((wallet) => {
      if (wallet) {
        allWalletParts.add(wallet);
      }
    });
  });
  const walletPartsList = Array.from(allWalletParts);
  const viewKeyByWallet = new Map<string, string>();
  for (
    let i = 0;
    i < walletPartsList.length;
    i += CONSOLIDATION_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = walletPartsList.slice(i, i + CONSOLIDATION_LOOKUP_CHUNK_SIZE);
    const rows = await fetchWalletConsolidationKeysViewForWallet(chunk);
    rows.forEach((row) => {
      // the view's row shape is { address, consolidation_key }
      const rowAddress = (row as unknown as { address: string }).address;
      if (rowAddress && !viewKeyByWallet.has(rowAddress.toLowerCase())) {
        viewKeyByWallet.set(rowAddress.toLowerCase(), row.consolidation_key);
      }
    });
  }

  const candidateKeys = new Set<string>();
  walletPartsList.forEach((wallet) => {
    candidateKeys.add(viewKeyByWallet.get(wallet.toLowerCase()) ?? wallet);
  });
  const candidateKeysList = Array.from(candidateKeys);
  const tdhByKey = new Map<string, number>();
  for (
    let i = 0;
    i < candidateKeysList.length;
    i += CONSOLIDATION_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = candidateKeysList.slice(
      i,
      i + CONSOLIDATION_LOOKUP_CHUNK_SIZE
    );
    const rows: { consolidation_key: string; boosted_tdh: number }[] =
      await sqlExecutor.execute(
        `SELECT consolidation_key, boosted_tdh FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
        WHERE consolidation_key IN (:chunk)`,
        { chunk }
      );
    rows.forEach((row) => {
      if (row.consolidation_key && !tdhByKey.has(row.consolidation_key)) {
        tdhByKey.set(row.consolidation_key, row.boosted_tdh ?? 0);
      }
    });
  }

  const replaceConsolidations = new Map<string, string>();

  for (const sub of affectedSubscriptions) {
    const walletParts = sub.consolidation_key.split('-');
    for (const wallet of walletParts) {
      const newConsolidationKey = wallet
        ? (viewKeyByWallet.get(wallet.toLowerCase()) ?? wallet)
        : wallet;

      const replaceConsolidation = replaceConsolidations.get(
        sub.consolidation_key
      );

      if (replaceConsolidation) {
        const replaceTdh = tdhByKey.get(replaceConsolidation) ?? 0;
        const newTdh = tdhByKey.get(newConsolidationKey) ?? 0;
        if (newTdh > replaceTdh) {
          replaceConsolidations.set(sub.consolidation_key, newConsolidationKey);
        } else {
          replaceConsolidations.set(
            sub.consolidation_key,
            replaceConsolidation
          );
        }
      } else {
        replaceConsolidations.set(sub.consolidation_key, newConsolidationKey);
      }
    }
  }

  const replaceTable = async (
    manager: any,
    table: string,
    newKey: string,
    oldKey: string
  ) => {
    try {
      await manager.query(
        `UPDATE ${table}
            SET consolidation_key = ?
            WHERE consolidation_key = ?`,
        [newKey, oldKey]
      );
    } catch (e) {
      logger.error(
        `Error updating ${table} for old key: ${oldKey} and new key: ${newKey}`,
        e
      );
    }
  };

  await getDataSource().transaction(async (manager) => {
    for (const oldKey of Array.from(replaceConsolidations.keys())) {
      const newKey = replaceConsolidations.get(oldKey);
      if (newKey) {
        await replaceTable(manager, SUBSCRIPTIONS_NFTS_TABLE, newKey, oldKey);
        await replaceTable(
          manager,
          SUBSCRIPTIONS_NFTS_FINAL_TABLE,
          newKey,
          oldKey
        );
        await replaceTable(manager, SUBSCRIPTIONS_LOGS_TABLE, newKey, oldKey);
        await replaceTable(
          manager,
          SUBSCRIPTIONS_REDEEMED_TABLE,
          newKey,
          oldKey
        );
      }
    }

    const uniqueValuesWithKeys = collections.getMapWithKeysAndValuesSwitched(
      replaceConsolidations
    );
    for (const value of Array.from(uniqueValuesWithKeys.keys())) {
      const keys = uniqueValuesWithKeys.get(value);
      if (!keys) {
        logger.error(`No keys found for value: ${value}`);
        continue;
      }

      const balanceQuery = `
            SELECT SUM(balance) as total_balance 
            FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
            WHERE consolidation_key IN (${keys.map(() => '?').join(',')})
        `;
      const balanceResult = await manager.query(balanceQuery, keys);
      const totalBalance = balanceResult[0]?.total_balance;

      const isSubscribedQuery = `
            SELECT COUNT(*) as automatic_count
            FROM ${SUBSCRIPTIONS_MODE_TABLE}
            WHERE consolidation_key IN (${keys.map(() => '?').join(',')})
            AND automatic = true
        `;
      const isSubscribedResult = await manager.query(isSubscribedQuery, keys);
      const isSubscribed = isSubscribedResult[0]?.automatic_count > 0;

      for (const key of keys) {
        await manager.query(
          `DELETE FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
                WHERE consolidation_key = ?`,
          [key]
        );
        await manager.query(
          `DELETE FROM ${SUBSCRIPTIONS_MODE_TABLE}
                WHERE consolidation_key = ?`,
          [key]
        );
      }

      await manager.query(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance)
            VALUES (?, ?)`,
        [value, totalBalance]
      );
      await manager.query(
        `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic)
            VALUES (?, ?)`,
        [value, isSubscribed]
      );
    }
  });
}
