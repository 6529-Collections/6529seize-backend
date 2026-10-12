import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { fetchSubscriptionEligibilityForKeys } from './db.subscriptions';
import { MINIMUM_SUBSCRIPTION_ELIGIBILITY } from './subscription-eligibility';
import { invalidateUpcomingSubscriptionCaches } from './subscription-cache';

const BATCH_SIZE = 500;

interface AutomaticSubscriptionQuantity {
  id: number;
  consolidation_key: string;
  subscribed_count: number;
}

/** Reconcile a committed reset in bounded transactions, evicting each committed page. */
export async function synchronizeAutomaticSubscriptionQuantitiesAfterReset(
  ctx?: RequestContext
): Promise<void> {
  if (ctx?.connection)
    throw new Error('Reset reconciliation must run after commit');
  const timerName = 'synchronizeAutomaticSubscriptionQuantitiesAfterReset';
  ctx?.timer?.start(timerName);
  try {
    const maxMemeId = await getMaxMemeId(true, { forcePool: DbPoolName.WRITE });
    let afterId = 0;
    for (;;) {
      const page = await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          const subscriptions = await fetchAutomaticQuantityPage(
            undefined,
            afterId,
            maxMemeId,
            options
          );
          const changedKeys = await synchronizeBatch(subscriptions, options);
          return { subscriptions, changedKeys };
        }
      );
      await invalidateUpcomingSubscriptionCaches(page.changedKeys);
      if (page.subscriptions.length < BATCH_SIZE) return;
      afterId = page.subscriptions.at(-1)!.id;
    }
  } finally {
    ctx?.timer?.stop(timerName);
  }
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
      let afterId = 0;
      for (;;) {
        const subscriptions = await fetchAutomaticQuantityPage(
          chunk,
          afterId,
          maxMemeId,
          options
        );
        for (const key of await synchronizeBatch(subscriptions, options)) {
          changedKeys.add(key);
        }
        if (subscriptions.length < BATCH_SIZE) break;
        afterId = subscriptions.at(-1)!.id;
      }
    }
    return Array.from(changedKeys);
  } finally {
    ctx.timer?.stop(timerName);
  }
}

async function fetchAutomaticQuantityPage(
  chunk: string[] | undefined,
  afterId: number,
  maxMemeId: number,
  options: DbQueryOptions
): Promise<AutomaticSubscriptionQuantity[]> {
  return sqlExecutor.execute<AutomaticSubscriptionQuantity>(
    `SELECT subscription.id, subscription.consolidation_key, subscription.subscribed_count
         FROM ${SUBSCRIPTIONS_NFTS_TABLE} subscription
         JOIN ${SUBSCRIPTIONS_MODE_TABLE} mode USING (consolidation_key)
         WHERE subscription.contract = :contract AND subscription.token_id > :maxMemeId
           AND subscription.subscribed = true AND subscription.automatic_subscription = true
           AND mode.automatic = true AND mode.subscribe_all_editions = true
           AND subscription.id > :afterId
           ${chunk ? 'AND subscription.consolidation_key IN (:chunk)' : ''}
         ORDER BY subscription.id LIMIT ${BATCH_SIZE}`,
    { contract: MEMES_CONTRACT, maxMemeId, chunk, afterId },
    options
  );
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
    { count, ids },
    options
  );
}
