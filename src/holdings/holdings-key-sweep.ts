import {
  ADDRESS_CONSOLIDATION_KEY,
  AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  NFT_OWNERS_CONSOLIDATION_TABLE,
  NFT_OWNERS_TABLE,
  OWNERS_BALANCES_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import {
  TransferConsumer,
  transferReconciliationDb
} from '@/transactions/transfer-reconciliation.db';

const logger = Logger.get('HOLDINGS_KEY_SWEEP');

// Queued per loop per sweep; the next sweep takes the rest.
const MAX_WALLETS_PER_CONSUMER = 2000;

/** A wallet table, the consolidated table built from it, and its loop. */
interface SweptTables {
  readonly consumer: TransferConsumer;
  readonly walletTable: string;
  readonly consolidatedTable: string;
  /**
   * A column whose rows count only when above 0, on both sides, as the loops
   * keep them; none when every row counts.
   */
  readonly positive: string | null;
}

const SWEPT: readonly SweptTables[] = [
  {
    consumer: 'owners',
    walletTable: NFT_OWNERS_TABLE,
    consolidatedTable: NFT_OWNERS_CONSOLIDATION_TABLE,
    positive: 'balance'
  },
  {
    consumer: 'balances',
    walletTable: OWNERS_BALANCES_TABLE,
    consolidatedTable: CONSOLIDATED_OWNERS_BALANCES_TABLE,
    positive: 'total_balance'
  },
  {
    consumer: 'activity',
    walletTable: AGGREGATED_ACTIVITY_TABLE,
    consolidatedTable: CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
    positive: null
  }
];

export interface HoldingsKeySweepResult {
  readonly consumer: TransferConsumer;
  readonly expected_keys: number;
  readonly stored_keys: number;
  /** Stored keys no wallet row maps to any more. */
  readonly stale_keys: number;
  /** Keys the wallet rows map to that have no stored row. */
  readonly missing_keys: number;
  /** Wallets that appear in more than one stored key. */
  readonly wallets_in_two_keys: number;
  readonly wallets_to_queue: number;
  readonly wallets_queued: number;
}

/** Each wallet row's key: its address_consolidation_keys key, else itself. */
async function expectedKeys(tables: SweptTables): Promise<Set<string>> {
  const rows = await sqlExecutor.execute<{ k: string }>(
    `SELECT DISTINCT COALESCE(a.consolidation_key, LOWER(w.wallet)) AS k
     FROM ${tables.walletTable} w
     LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} a ON a.address = LOWER(w.wallet)
     WHERE ${tables.positive ? `w.${tables.positive} > 0` : 'TRUE'}`
  );
  return new Set(rows.map((row) => row.k.toLowerCase()));
}

async function storedKeys(tables: SweptTables): Promise<Set<string>> {
  const rows = await sqlExecutor.execute<{ k: string }>(
    `SELECT DISTINCT consolidation_key AS k FROM ${tables.consolidatedTable}
     WHERE ${tables.positive ? `${tables.positive} > 0` : 'TRUE'}`
  );
  return new Set(rows.map((row) => row.k.toLowerCase()));
}

function walletsOf(key: string): string[] {
  return key.split('-').filter(Boolean);
}

async function sweepTables(
  tables: SweptTables,
  repair: boolean
): Promise<HoldingsKeySweepResult> {
  const expected = await expectedKeys(tables);
  const stored = await storedKeys(tables);
  const wallets = new Set<string>();
  let stale = 0;
  let missing = 0;
  stored.forEach((key) => {
    if (expected.has(key)) return;
    stale++;
    walletsOf(key).forEach((wallet) => wallets.add(wallet));
  });
  expected.forEach((key) => {
    if (stored.has(key)) return;
    missing++;
    walletsOf(key).forEach((wallet) => wallets.add(wallet));
  });
  const keyOfWallet = new Map<string, string>();
  const inTwoKeys = new Set<string>();
  stored.forEach((key) => {
    walletsOf(key).forEach((wallet) => {
      const other = keyOfWallet.get(wallet);
      if (other !== undefined && other !== key) inTwoKeys.add(wallet);
      keyOfWallet.set(wallet, key);
    });
  });
  inTwoKeys.forEach((wallet) => wallets.add(wallet));

  const toQueue = Array.from(wallets)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_WALLETS_PER_CONSUMER);
  if (repair && toQueue.length) {
    await transferReconciliationDb.enqueueFor(toQueue, tables.consumer);
  }
  return {
    consumer: tables.consumer,
    expected_keys: expected.size,
    stored_keys: stored.size,
    stale_keys: stale,
    missing_keys: missing,
    wallets_in_two_keys: inTwoKeys.size,
    wallets_to_queue: wallets.size,
    wallets_queued: repair ? toQueue.length : 0
  };
}

/**
 * Compares each consolidated holdings table with the keys its wallet rows map
 * to in address_consolidation_keys. With `repair`, queues the wallets of
 * every stale or missing key, and of every wallet stored under two keys, for
 * the loop that writes the table; otherwise only reports. A wallet already
 * queued keeps its place, so a sweep never delays the loops' own work.
 */
export async function sweepHoldingsKeys({
  repair
}: {
  repair: boolean;
}): Promise<HoldingsKeySweepResult[]> {
  const results: HoldingsKeySweepResult[] = [];
  for (const tables of SWEPT) {
    results.push(await sweepTables(tables, repair));
  }
  const mismatched = results.some((result) => result.wallets_to_queue > 0);
  if (mismatched) {
    logger.warn({
      message: '[HOLDINGS KEY SWEEP: MISMATCHES]',
      repair,
      results
    });
  } else {
    logger.info({ message: '[HOLDINGS KEY SWEEP: CLEAN]', results });
  }
  return results;
}
