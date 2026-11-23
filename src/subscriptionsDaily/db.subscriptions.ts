import { EntityManager } from 'typeorm';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  MEMES_SEASONS_TABLE
} from '@/constants';
import { getDataSource } from '../db';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { insertWithoutUpdate } from '../orm_helpers';
import {
  DeferralReason,
  deferralReason,
  DeferredWrite,
  DeferredWriteSink,
  deferSubscriptionWrites,
  executorSink
} from '@/subscription-key-width/subscription-deferred-writes';
import { sqlExecutor } from '../sql-executor';
import { DbQueryOptions } from '@/db-query.options';
import {
  MINIMUM_SUBSCRIPTION_ELIGIBILITY,
  normalizeSubscriptionEligibility
} from './subscription-eligibility';

export async function fetchAllAutoSubscriptions() {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .find({ where: { automatic: true }, order: { created_at: 'ASC' } });
}

export async function fetchSubscriptionModeForConsolidationKey(
  consolidationKey: string
) {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .findOne({ where: { consolidation_key: consolidationKey } });
}

export async function fetchAllNftSubscriptions(contract: string, id: number) {
  return await getDataSource()
    .getRepository(NFTSubscription)
    .find({ where: { contract: contract, token_id: id } });
}

export async function fetchAllNftSubscriptionBalances() {
  return await getDataSource().getRepository(SubscriptionBalance).find();
}

export async function fetchNftFinalSubscriptionForConsolidationKey(
  contract: string,
  token_id: number,
  consolidation_key: string
) {
  return await getDataSource().getRepository(NFTFinalSubscription).find({
    where: {
      contract,
      token_id,
      consolidation_key
    }
  });
}

async function lockBalanceRow(
  manager: EntityManager,
  consolidationKey: string
): Promise<SubscriptionBalance | null> {
  return await manager.getRepository(SubscriptionBalance).findOne({
    where: { consolidation_key: consolidationKey },
    lock: { mode: 'pessimistic_write' }
  });
}

/**
 * The balance row a top-up or charge for a key changes, read FOR UPDATE in
 * the caller's transaction: the latest committed row, held until that
 * transaction ends, so another top-up, charge or merge of the key waits
 * instead of overwriting it. Write it back with writeSubscriptionBalance.
 *
 * A merge deletes the rows of the keys it folds in. When the key has no row,
 * its wallets are looked up again in address_consolidation_keys, with a
 * locking read so the latest mapping is seen rather than the transaction's
 * snapshot. If they all belong to one other key now, that key's row is used
 * and its key returned, so the write never recreates a merged-away key.
 */
export async function lockSubscriptionBalance(
  consolidationKey: string,
  manager: EntityManager
): Promise<{ consolidationKey: string; balance: SubscriptionBalance | null }> {
  const balance = await lockBalanceRow(manager, consolidationKey);
  if (balance) {
    return { consolidationKey, balance };
  }
  const wallets = consolidationKey.split('-').filter((wallet) => wallet);
  const rows: { consolidation_key: string }[] = wallets.length
    ? await manager.query(
        `SELECT consolidation_key FROM ${ADDRESS_CONSOLIDATION_KEY}
          WHERE address IN (${wallets.map(() => '?').join(', ')})
          FOR SHARE`,
        wallets
      )
    : [];
  const currentKeys = Array.from(
    new Set(rows.map((row) => row.consolidation_key))
  );
  if (currentKeys.length !== 1 || currentKeys[0] === consolidationKey) {
    return { consolidationKey, balance: null };
  }
  return {
    consolidationKey: currentKeys[0],
    balance: await lockBalanceRow(manager, currentKeys[0])
  };
}

/**
 * Writes a balance read with lockSubscriptionBalance: an UPDATE when that
 * read found the row, an INSERT when it found none. Not save(), which looks
 * the row up again in the transaction's snapshot and can update a row a
 * merge has since deleted, or insert one a merge has since created.
 */
export async function writeSubscriptionBalance(
  manager: EntityManager,
  balance: SubscriptionBalance,
  found: boolean
): Promise<void> {
  const repository = manager.getRepository(SubscriptionBalance);
  if (found) {
    await repository.update(
      { consolidation_key: balance.consolidation_key },
      { balance: balance.balance }
    );
  } else {
    await repository.insert(balance);
  }
}

/**
 * Rows and log lines split by key: a key whose writes must wait (it does
 * not fit every subscription table, or it has earlier writes waiting) has
 * its row and every log line deferred together; the rest are written.
 */
interface KeySplit<R> {
  readonly rows: R[];
  readonly logs: SubscriptionLog[];
  readonly deferred: DeferredWrite[];
}

async function splitByKey<R extends { consolidation_key: string }>(
  rows: readonly R[],
  logs: readonly SubscriptionLog[],
  kind: 'AUTO_SUBSCRIPTION' | 'FINAL_ROW',
  dedupeOf: (row: R) => string,
  sink: DeferredWriteSink = executorSink(),
  // Inside the caller's transaction, which then writes the split: read the
  // waiting writes FOR SHARE (see deferralReason).
  locking = false
): Promise<KeySplit<R>> {
  const reasons = new Map<string, DeferralReason | null>();
  const keys = Array.from(
    new Set([
      ...rows.map((r) => r.consolidation_key),
      ...logs.map((l) => l.consolidation_key)
    ])
  );
  for (const key of keys) {
    reasons.set(key, await deferralReason(key, sink, undefined, { locking }));
  }
  const split: {
    rows: R[];
    logs: SubscriptionLog[];
    deferred: DeferredWrite[];
  } = { rows: [], logs: [], deferred: [] };
  for (const row of rows) {
    const reason = reasons.get(row.consolidation_key);
    if (reason) {
      split.deferred.push({
        kind,
        consolidationKey: row.consolidation_key,
        dedupe: dedupeOf(row),
        payload: row,
        reason
      });
    } else {
      split.rows.push(row);
    }
  }
  for (const log of logs) {
    const reason = reasons.get(log.consolidation_key);
    if (reason) {
      split.deferred.push({
        kind: 'LOG',
        consolidationKey: log.consolidation_key,
        dedupe: `${log.consolidation_key}|${log.log}|${log.additional_info ?? ''}`,
        payload: log,
        reason
      });
    } else {
      split.logs.push(log);
    }
  }
  return split;
}

/**
 * A card's final rows and the build's log lines, split by key. This split
 * reads outside the write's transaction, because the list is published in
 * between and the file must hold the same subscribers as the rows.
 */
export function splitFinalList(
  rows: readonly NFTFinalSubscription[],
  logs: readonly SubscriptionLog[]
): Promise<KeySplit<NFTFinalSubscription>> {
  return splitByKey(
    rows,
    logs,
    'FINAL_ROW',
    (r) => `${r.consolidation_key}|${r.contract}|${r.token_id}`
  );
}

export async function persistSubscriptions(
  subscriptions: NFTSubscription[],
  logs: SubscriptionLog[]
) {
  await getDataSource().transaction(async (manager) => {
    // Read inside the transaction, so a write queued for a key meanwhile
    // keeps this one behind it.
    const split = await splitByKey(
      subscriptions,
      logs,
      'AUTO_SUBSCRIPTION',
      (r) => `${r.consolidation_key}|${r.contract}|${r.token_id}`,
      manager,
      true
    );
    if (split.rows.length) {
      await manager
        .getRepository(NFTSubscription)
        .upsert(split.rows, ['consolidation_key', 'contract', 'token_id']);
    }
    if (split.logs.length) {
      await manager.getRepository(SubscriptionLog).insert(split.logs);
    }
    await deferSubscriptionWrites(split.deferred, manager);
  });
}

/**
 * Replaces a card's final rows with the split list. The caller splits first
 * (`splitFinalList`) so the published file and these rows hold the same
 * subscribers.
 */
export async function persistNFTFinalSubscriptions(
  contract: string,
  token_id: number,
  upload: NFTFinalSubscriptionUpload,
  split: KeySplit<NFTFinalSubscription>
) {
  await getDataSource().transaction(async (manager) => {
    const finalRepo = manager.getRepository(NFTFinalSubscription);
    const uploadRepo = manager.getRepository(NFTFinalSubscriptionUpload);
    await finalRepo.delete({
      contract: contract,
      token_id: token_id
    });
    if (split.rows.length) {
      await insertWithoutUpdate(finalRepo, split.rows);
    }
    await uploadRepo.upsert(upload, ['contract', 'token_id']);

    if (split.logs.length) {
      await manager.getRepository(SubscriptionLog).insert(split.logs);
    }
    await deferSubscriptionWrites(split.deferred, manager);
  });
}

export async function fetchSubscriptionEligibility(
  consolidationKey: string
): Promise<number> {
  const eligibility = await fetchSubscriptionEligibilityForKeys([
    consolidationKey
  ]);
  return (
    eligibility.get(consolidationKey.toLowerCase()) ??
    MINIMUM_SUBSCRIPTION_ELIGIBILITY
  );
}

const ELIGIBILITY_KEYS_CHUNK_SIZE = 5000;

/**
 * Eligible card-set count (min 1) per consolidation key, resolved with one
 * MAX(season) query plus one chunked IN query instead of two queries per key.
 * Keys of the returned map are lowercased.
 */
export async function fetchSubscriptionEligibilityForKeys(
  consolidationKeys: string[],
  options?: DbQueryOptions
): Promise<Map<string, number>> {
  const eligibility = new Map<string, number>();
  consolidationKeys.forEach((key) => {
    if (key) {
      eligibility.set(key.toLowerCase(), MINIMUM_SUBSCRIPTION_ELIGIBILITY);
    }
  });
  if (eligibility.size === 0) {
    return eligibility;
  }

  const maxSeasonId = await sqlExecutor.execute<{ max_id: number }>(
    `SELECT MAX(id) as max_id FROM ${MEMES_SEASONS_TABLE}`,
    undefined,
    options
  );

  if (!maxSeasonId || maxSeasonId.length === 0 || !maxSeasonId[0].max_id) {
    return eligibility;
  }

  const seasonId = maxSeasonId[0].max_id;
  const distinctKeys = Array.from(eligibility.keys());

  for (let i = 0; i < distinctKeys.length; i += ELIGIBILITY_KEYS_CHUNK_SIZE) {
    const chunk = distinctKeys.slice(i, i + ELIGIBILITY_KEYS_CHUNK_SIZE);
    const cardSetsResult = await sqlExecutor.execute<{
      consolidation_key: string;
      sets: number;
    }>(
      `SELECT consolidation_key, sets FROM ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}
       WHERE consolidation_key IN (:chunk) AND season = :seasonId`,
      { chunk, seasonId },
      options
    );
    cardSetsResult.forEach((row) => {
      if (row.consolidation_key) {
        eligibility.set(
          row.consolidation_key.toLowerCase(),
          normalizeSubscriptionEligibility(row.sets)
        );
      }
    });
  }

  return eligibility;
}
