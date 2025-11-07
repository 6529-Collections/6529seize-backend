import {
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_TABLE
} from '../constants';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { sqlExecutor } from '../sql-executor';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    { logger }
  );
});

async function replay() {
  const TOKEN_ID = 412;
  const CONTRACT = MEMES_CONTRACT;

  logger.info(`[STARTING REPLAY] Token ID: ${TOKEN_ID}, Contract: ${CONTRACT}`);

  // Step 1: Get subscriptions_nfts_final for token_id 412, contract "the memes"
  logger.info(
    `[STEP 1] Fetching subscriptions_nfts_final for token_id ${TOKEN_ID} and contract ${CONTRACT}`
  );
  const finalSubscriptions = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} 
    WHERE contract = :contract 
    AND token_id = :tokenId`,
    { contract: CONTRACT, tokenId: TOKEN_ID }
  );

  logger.info(
    `[STEP 1 RESULT] Found ${finalSubscriptions.length} subscriptions_nfts_final records`
  );

  if (finalSubscriptions.length === 0) {
    logger.warn(`[STEP 1] No subscriptions_nfts_final found. Exiting.`);
    return;
  }

  // Step 2: Match these with transactions table for airdrops (from null address) to 'airdrop_address'
  logger.info(
    `[STEP 2] Matching subscriptions_nfts_final with transactions for airdrops (from ${NULL_ADDRESS})`
  );

  const airdropAddresses = finalSubscriptions.map((sub) =>
    sub.airdrop_address.toLowerCase()
  );
  const uniqueAirdropAddresses = Array.from(new Set(airdropAddresses));
  logger.info(
    `[STEP 2] Looking for transactions to ${uniqueAirdropAddresses.length} unique airdrop addresses`
  );
  logger.info(
    `[STEP 2] Airdrop addresses: ${JSON.stringify(uniqueAirdropAddresses)}`
  );

  const airdropTransactions = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE} 
    WHERE contract = :contract 
    AND token_id = :tokenId
    AND from_address = :nullAddress
    AND value = 0
    AND token_count > 0
    AND LOWER(to_address) IN (:airdropAddresses)
    ORDER BY block ASC`,
    {
      contract: CONTRACT,
      tokenId: TOKEN_ID,
      nullAddress: NULL_ADDRESS,
      airdropAddresses: uniqueAirdropAddresses
    }
  );

  logger.info(
    `[STEP 2 RESULT] Found ${airdropTransactions.length} airdrop transactions`
  );

  // Create a map of airdrop_address -> transactions
  const airdropAddressToTransactions = new Map<string, any[]>();
  airdropTransactions.forEach((tx) => {
    const addr = tx.to_address.toLowerCase();
    if (!airdropAddressToTransactions.has(addr)) {
      airdropAddressToTransactions.set(addr, []);
    }
    airdropAddressToTransactions.get(addr)!.push(tx);
  });

  logger.info(
    `[STEP 2 MAPPING] Created map of ${airdropAddressToTransactions.size} airdrop addresses with transactions`
  );

  // Step 3: Get all subscriptions_redeemed for token 412
  logger.info(
    `[STEP 3] Fetching all subscriptions_redeemed for token_id ${TOKEN_ID}`
  );
  const redeemedSubscriptions = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} 
    WHERE contract = :contract 
    AND token_id = :tokenId`,
    { contract: CONTRACT, tokenId: TOKEN_ID }
  );

  logger.info(
    `[STEP 3 RESULT] Found ${redeemedSubscriptions.length} subscriptions_redeemed records`
  );

  // Step 4: Match the subscriptions_nfts_final which had a transaction to subscriptions_redeemed
  // and flag the subscriptions_redeemed missing (use 'address' of subscriptions_redeemed)
  logger.info(
    `[STEP 4] Matching subscriptions_nfts_final with transactions to subscriptions_redeemed and identifying missing ones`
  );

  // Find final subscriptions that had transactions
  const finalSubscriptionsWithTransactions = finalSubscriptions.filter(
    (finalSub) => {
      const addr = finalSub.airdrop_address.toLowerCase();
      return airdropAddressToTransactions.has(addr);
    }
  );

  logger.info(
    `[STEP 4] Found ${finalSubscriptionsWithTransactions.length} subscriptions_nfts_final that had airdrop transactions`
  );

  // Create a map of (address + consolidation_key) -> subscriptions_redeemed for matching
  // This accounts for multiple subscriptions_nfts_final with the same airdrop_address
  const redeemedMap = new Map<string, any[]>();
  redeemedSubscriptions.forEach((redeemed) => {
    const key = `${redeemed.address.toLowerCase()}:${redeemed.consolidation_key.toLowerCase()}`;
    if (!redeemedMap.has(key)) {
      redeemedMap.set(key, []);
    }
    redeemedMap.get(key)!.push(redeemed);
  });

  logger.info(
    `[STEP 4] Created map of ${redeemedMap.size} unique (address:consolidation_key) combinations from subscriptions_redeemed`
  );

  // Count subscriptions_nfts_final by airdrop_address to show duplicates
  const addressCounts = new Map<string, number>();
  finalSubscriptionsWithTransactions.forEach((finalSub) => {
    const addr = finalSub.airdrop_address.toLowerCase();
    addressCounts.set(addr, (addressCounts.get(addr) || 0) + 1);
  });
  const duplicateAddresses = Array.from(addressCounts.entries()).filter(
    ([, count]) => count > 1
  );
  if (duplicateAddresses.length > 0) {
    logger.info(
      `[STEP 4] Found ${duplicateAddresses.length} airdrop addresses with multiple subscriptions_nfts_final:`
    );
    duplicateAddresses.forEach(([addr, count]) => {
      logger.info(
        `[STEP 4] Address ${addr} has ${count} subscriptions_nfts_final`
      );
    });
  }

  // Find missing subscriptions_redeemed
  // Match by both address AND consolidation_key to handle multiple subscriptions_nfts_final with same address
  const missingRedeemed: Array<{
    finalSubscription: any;
    airdropAddress: string;
    consolidationKey: string;
    transactions: any[];
  }> = [];

  finalSubscriptionsWithTransactions.forEach((finalSub) => {
    const airdropAddr = finalSub.airdrop_address.toLowerCase();
    const consolidationKey = finalSub.consolidation_key.toLowerCase();
    const transactions = airdropAddressToTransactions.get(airdropAddr) || [];

    // Check if there's a matching subscriptions_redeemed by address AND consolidation_key
    const matchKey = `${airdropAddr}:${consolidationKey}`;
    const hasRedeemed = redeemedMap.has(matchKey);

    if (!hasRedeemed) {
      missingRedeemed.push({
        finalSubscription: finalSub,
        airdropAddress: airdropAddr,
        consolidationKey: consolidationKey,
        transactions
      });
    }
  });

  logger.info(
    `[STEP 4 RESULT] Found ${missingRedeemed.length} subscriptions_nfts_final with transactions but missing in subscriptions_redeemed`
  );
  if (missingRedeemed.length > 0) {
    logger.info(`[STEP 4 MISSING ENTRIES]`);
    missingRedeemed.forEach((missing, index) => {
      logger.info(
        `[STEP 4 MISSING ${index + 1}] Airdrop Address: ${missing.airdropAddress}, Consolidation Key: ${missing.consolidationKey}, Balance: ${missing.finalSubscription.balance}, Transaction Count: ${missing.transactions.length}`
      );
    });
  }

  // Summary
  logger.info(`[SUMMARY]`);
  logger.info(
    `  - Total subscriptions_nfts_final: ${finalSubscriptions.length}`
  );
  logger.info(
    `  - Total airdrop transactions found: ${airdropTransactions.length}`
  );
  logger.info(
    `  - Total subscriptions_redeemed: ${redeemedSubscriptions.length}`
  );
  logger.info(
    `  - subscriptions_nfts_final with transactions: ${finalSubscriptionsWithTransactions.length}`
  );
  logger.info(`  - Missing subscriptions_redeemed: ${missingRedeemed.length}`);

  logger.info(`[REPLAY COMPLETE]`);
}
