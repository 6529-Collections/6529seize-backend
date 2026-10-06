import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { DbQueryOptions } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { fetchSubscriptionEligibilityForKeys } from './db.subscriptions';
import { MINIMUM_SUBSCRIPTION_ELIGIBILITY } from './subscription-eligibility';

const BATCH_SIZE = 500;

interface AutomaticSubscriptionQuantity {
  id: number;
  consolidation_key: string;
  subscribed_count: number;
}

/** Run in the writer's transaction, after eligibility or mode has been saved. */
export async function synchronizeAutomaticSubscriptionQuantities(
  consolidationKeys: readonly string[] | undefined,
  ctx: RequestContext
): Promise<string[]> {
  if (!ctx.connection) {
    throw new Error(
      'Subscription quantity synchronization requires a transaction'
    );
  }
  const keys = consolidationKeys && Array.from(new Set(consolidationKeys));
  if (keys?.length === 0) {
    return [];
  }
  const timerName = 'synchronizeAutomaticSubscriptionQuantities';
  ctx.timer?.start(timerName);
  try {
    const options = { wrappedConnection: ctx.connection };
    // Match the upcoming API, including an ingested mint-day card. Finalized
    // allocations are a separate table and are never changed by this sync.
    const maxMemeId = await getMaxMemeId(true, options);
    const changedKeys = new Set<string>();
    const batches = keys ?? [undefined];
    for (let start = 0; start < batches.length; start += BATCH_SIZE) {
      const chunk = keys ? keys.slice(start, start + BATCH_SIZE) : undefined;
      const subscriptions =
        await sqlExecutor.execute<AutomaticSubscriptionQuantity>(
          `SELECT subscription.id, subscription.consolidation_key, subscription.subscribed_count
         FROM ${SUBSCRIPTIONS_NFTS_TABLE} subscription
         JOIN ${SUBSCRIPTIONS_MODE_TABLE} mode USING (consolidation_key)
         WHERE subscription.contract = :contract AND subscription.token_id > :maxMemeId
           AND subscription.subscribed = true AND subscription.automatic_subscription = true
           AND mode.automatic = true AND mode.subscribe_all_editions = true
           ${chunk ? 'AND subscription.consolidation_key IN (:chunk)' : ''}`,
          { contract: MEMES_CONTRACT, maxMemeId, chunk },
          options
        );
      for (const key of await synchronizeBatch(subscriptions, options)) {
        changedKeys.add(key);
      }
    }
    return Array.from(changedKeys);
  } finally {
    ctx.timer?.stop(timerName);
  }
}

async function synchronizeBatch(
  subscriptions: AutomaticSubscriptionQuantity[],
  options: DbQueryOptions
): Promise<string[]> {
  const eligibility = await fetchSubscriptionEligibilityForKeys(
    subscriptions.map((subscription) => subscription.consolidation_key),
    options
  );
  const idsByCount = new Map<number, number[]>();
  const changedKeys = new Set<string>();
  for (const subscription of subscriptions) {
    const count =
      eligibility.get(subscription.consolidation_key.toLowerCase()) ??
      MINIMUM_SUBSCRIPTION_ELIGIBILITY;
    if (subscription.subscribed_count === count) continue;
    const ids = idsByCount.get(count) ?? [];
    ids.push(subscription.id);
    idsByCount.set(count, ids);
    changedKeys.add(subscription.consolidation_key);
  }
  for (const [count, ids] of Array.from(idsByCount)) {
    await updateAutomaticQuantities(count, ids, options);
  }
  return Array.from(changedKeys);
}

async function updateAutomaticQuantities(
  count: number,
  ids: number[],
  options: DbQueryOptions
): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    // Recheck intent at WRITE time: a manual update committed after the
    // SELECT must win. Keep timestamps used for subscription priority.
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTIONS_NFTS_TABLE} subscription
       JOIN ${SUBSCRIPTIONS_MODE_TABLE} mode USING (consolidation_key)
       SET subscription.subscribed_count = :count,
           subscription.updated_at = subscription.updated_at
       WHERE subscription.id IN (:ids)
         AND subscription.subscribed = true AND subscription.automatic_subscription = true
         AND mode.automatic = true AND mode.subscribe_all_editions = true
         AND subscription.subscribed_count <> :count`,
      { count, ids: ids.slice(offset, offset + BATCH_SIZE) },
      options
    );
  }
}
