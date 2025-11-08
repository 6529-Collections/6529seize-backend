import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_TABLE
} from '../constants';
import { getDataSource } from '../db';
import {
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance
} from '../entities/ISubscription';
import { Transaction } from '../entities/ITransaction';
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
  const UPDATE_REDEEMED_SUBSCRIPTIONS = true;

  logger.info(`[STARTING REPLAY] Token ID: ${TOKEN_ID}, Contract: ${CONTRACT}`);

  // Step 1: Get subscriptions_nfts_final for token_id 412, contract "the memes"
  logger.info(
    `[STEP 1] Fetching subscriptions_nfts_final for token_id ${TOKEN_ID} and contract ${CONTRACT}`
  );
  const finalSubscriptions = await sqlExecutor.execute<NFTFinalSubscription>(
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

  const IGNORED_TRANSACTION =
    '0x62ee19b3dcefdb0a6f35dc5c8549f8f694b6b427411d1a9d5f7881c77b64e9f1';

  const airdropTransactions = await sqlExecutor.execute<Transaction>(
    `SELECT * FROM ${TRANSACTIONS_TABLE} 
    WHERE contract = :contract 
    AND token_id = :tokenId
    AND from_address = :nullAddress
    AND value = 0
    AND token_count > 0
    AND transaction != :ignoredTransaction
    AND LOWER(to_address) IN (:airdropAddresses)
    ORDER BY block ASC`,
    {
      contract: CONTRACT,
      tokenId: TOKEN_ID,
      nullAddress: NULL_ADDRESS,
      ignoredTransaction: IGNORED_TRANSACTION,
      airdropAddresses: uniqueAirdropAddresses
    }
  );

  logger.info(
    `[STEP 2 RESULT] Found ${airdropTransactions.length} airdrop transactions`
  );

  // Create a map of airdrop_address -> transactions
  const airdropAddressToTransactions = new Map<string, Transaction[]>();
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
  const redeemedSubscriptions = await sqlExecutor.execute<RedeemedSubscription>(
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
  const redeemedMap = new Map<string, RedeemedSubscription[]>();
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
    const totalDuplicates = duplicateAddresses.reduce(
      (sum, [, count]) => sum + count,
      0
    );
    logger.info(
      `[STEP 4] Found ${duplicateAddresses.length} airdrop addresses with multiple subscriptions_nfts_final (${totalDuplicates} total entries)`
    );
  }

  // Find missing subscriptions_redeemed
  // Match by both address AND consolidation_key to handle multiple subscriptions_nfts_final with same address
  interface MissingRedeemed {
    finalSubscription: NFTFinalSubscription;
    airdropAddress: string;
    consolidationKey: string;
    transactions: Transaction[];
  }
  const missingRedeemed: MissingRedeemed[] = [];

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

  // Step 5: Process missing redeemed entries per transaction (like redeemSubscriptions)
  logger.info(
    `[STEP 5] Processing missing redeemed entries (DRY RUN: ${!UPDATE_REDEEMED_SUBSCRIPTIONS})`
  );

  if (missingRedeemed.length === 0) {
    logger.info(`[STEP 5] No missing redeemed entries to process`);
  } else {
    // Collect subscriptions to process (one per subscription, use first transaction)
    // Each subscription should only be processed once, even if it has multiple transactions
    interface SubscriptionToProcess {
      transaction: Transaction;
      finalSubscription: NFTFinalSubscription;
    }
    const subscriptionsToProcess: SubscriptionToProcess[] = [];
    missingRedeemed.forEach((missing) => {
      // Use the first transaction for each subscription
      const transaction = missing.transactions[0];
      if (transaction) {
        subscriptionsToProcess.push({
          transaction: transaction,
          finalSubscription: missing.finalSubscription
        });
      }
    });

    logger.info(
      `[STEP 5] Processing ${subscriptionsToProcess.length} subscriptions (one per missing entry)`
    );

    // Get unique consolidation keys for statistics
    const consolidationKeys = Array.from(
      new Set(missingRedeemed.map((m) => m.consolidationKey))
    );

    // Fetch all balances upfront
    const balances = await sqlExecutor.execute<SubscriptionBalance>(
      `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE} 
      WHERE consolidation_key IN (:consolidationKeys)`,
      { consolidationKeys }
    );

    const balanceMap = new Map<string, SubscriptionBalance>();
    balances.forEach((bal) => {
      balanceMap.set(bal.consolidation_key.toLowerCase(), bal);
    });

    // Collect statistics
    let entriesWithBalance = 0;
    let entriesWithEnoughBalance = 0;
    const consolidationKeysWithBalance = new Set<string>();
    const consolidationKeysWithEnoughBalance = new Set<string>();

    // Process each subscription to collect stats
    for (const item of subscriptionsToProcess) {
      const { finalSubscription } = item;
      const consolidationKey =
        finalSubscription.consolidation_key.toLowerCase();

      if (!consolidationKeysWithBalance.has(consolidationKey)) {
        const balance = balanceMap.get(consolidationKey);

        if (balance) {
          consolidationKeysWithBalance.add(consolidationKey);
          entriesWithBalance++;
          if (balance.balance >= MEMES_MINT_PRICE) {
            consolidationKeysWithEnoughBalance.add(consolidationKey);
            entriesWithEnoughBalance++;
          }
        }
      }
    }

    // Count entries without balance and without enough balance
    const entriesWithoutBalance =
      consolidationKeys.length - consolidationKeysWithBalance.size;
    const entriesWithoutEnoughBalance =
      consolidationKeysWithBalance.size -
      consolidationKeysWithEnoughBalance.size;

    logger.info(`[STEP 5 STATISTICS]`);
    logger.info(`  - Entries with balance: ${entriesWithBalance}`);
    logger.info(`  - Entries WITHOUT balance: ${entriesWithoutBalance}`);
    logger.info(
      `  - Entries with enough balance (>= ${MEMES_MINT_PRICE}): ${entriesWithEnoughBalance}`
    );
    logger.info(
      `  - Entries WITHOUT enough balance: ${entriesWithoutEnoughBalance}`
    );

    // Process transactions if not dry-run
    if (UPDATE_REDEEMED_SUBSCRIPTIONS) {
      logger.info(`[STEP 5] UPDATING DATABASE (NOT DRY RUN)`);

      await getDataSource().transaction(async (entityManager) => {
        let processedCount = 0;
        let skippedCount = 0;

        for (const item of subscriptionsToProcess) {
          const { transaction, finalSubscription } = item;
          const consolidationKey =
            finalSubscription.consolidation_key.toLowerCase();

          // Use the subscription we already have
          const subscription = finalSubscription;

          // Check if already redeemed
          if (subscription.redeemed) {
            logger.warn(
              `[STEP 5 SKIP] Subscription already redeemed for transaction: ${transaction.transaction}`
            );
            skippedCount++;
            continue;
          }

          // Get balance from map (already fetched)
          // If no balance exists, create one with 0 balance (will go negative)
          let balance: SubscriptionBalance | undefined =
            balanceMap.get(consolidationKey);
          if (!balance) {
            balance = new SubscriptionBalance();
            balance.consolidation_key = consolidationKey;
            balance.balance = 0;
            logger.warn(
              `[STEP 5] No balance found for consolidation_key: ${consolidationKey}, creating with 0 balance (will go negative), transaction: ${transaction.transaction}`
            );
          }

          // Calculate balance after (allow negative)
          let balanceAfter = balance.balance - MEMES_MINT_PRICE;
          balanceAfter = Math.round(balanceAfter * 100000) / 100000;
          balance.balance = balanceAfter;

          await entityManager.getRepository(SubscriptionBalance).save(balance);

          // Update balance in map for subsequent subscriptions with same consolidation_key
          balanceMap.set(consolidationKey, balance);

          // Create redeemed subscription
          const redeemedSubscription: RedeemedSubscription = {
            contract: transaction.contract,
            token_id: transaction.token_id,
            address: transaction.to_address,
            transaction: transaction.transaction,
            transaction_date: transaction.transaction_date,
            consolidation_key: consolidationKey,
            value: MEMES_MINT_PRICE,
            balance_after: balanceAfter
          };

          await entityManager
            .getRepository(RedeemedSubscription)
            .save(redeemedSubscription);

          // Mark final subscription as redeemed
          subscription.redeemed = true;
          await entityManager
            .getRepository(NFTFinalSubscription)
            .save(subscription);

          processedCount++;
        }

        logger.info(
          `[STEP 5 RESULT] Processed ${processedCount} transactions, skipped ${skippedCount} transactions`
        );
      });
    } else {
      logger.info(`[STEP 5] DRY RUN - No database updates performed`);
    }
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
