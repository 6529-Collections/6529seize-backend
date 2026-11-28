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

/**
 * Where a consolidated table's keys should come from: the wallets of a wallet
 * table, each mapped through address_consolidation_keys (else itself).
 * owners_balances has one row per wallet that holds anything, so it stands in
 * for nft_owners (one row per token held) and costs one lookup per wallet,
 * not one per token.
 */
interface KeySource {
  readonly walletTable: string;
  /** A column whose rows count only when above 0; none when every row does. */
  readonly positive: string | null;
}

interface SweptTable {
  readonly consumer: TransferConsumer;
  readonly consolidatedTable: string;
  readonly positive: string | null;
  readonly expected: KeySource;
}

const HOLDERS: KeySource = {
  walletTable: OWNERS_BALANCES_TABLE,
  positive: 'total_balance'
};

const SWEPT: readonly SweptTable[] = [
  {
    consumer: 'owners',
    consolidatedTable: NFT_OWNERS_CONSOLIDATION_TABLE,
    positive: 'balance',
    expected: HOLDERS
  },
  {
    consumer: 'balances',
    consolidatedTable: CONSOLIDATED_OWNERS_BALANCES_TABLE,
    positive: 'total_balance',
    expected: HOLDERS
  },
  {
    consumer: 'activity',
    consolidatedTable: CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
    positive: null,
    expected: { walletTable: AGGREGATED_ACTIVITY_TABLE, positive: null }
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

/** Grouped totals against wallet totals; report mode only. */
export interface HoldingsSumCheck {
  /** NFT tokens (contract, token id) whose held total differs. */
  readonly nft_tokens_compared: number;
  readonly nft_tokens_differing: number;
  readonly wallet_total_balance: number;
  readonly consolidated_total_balance: number;
}

export interface HoldingsKeySweepReport {
  readonly tables: HoldingsKeySweepResult[];
  readonly sums: HoldingsSumCheck | null;
}

const where = (alias: string, positive: string | null) =>
  positive ? `${alias}${positive} > 0` : 'TRUE';

async function expectedKeys(source: KeySource): Promise<Set<string>> {
  const rows = await sqlExecutor.execute<{ k: string }>(
    `SELECT DISTINCT COALESCE(a.consolidation_key, LOWER(w.wallet)) AS k
     FROM ${source.walletTable} w
     LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} a ON a.address = LOWER(w.wallet)
     WHERE ${where('w.', source.positive)}`
  );
  return new Set(rows.map((row) => row.k.toLowerCase()));
}

async function storedKeys(table: SweptTable): Promise<Set<string>> {
  const rows = await sqlExecutor.execute<{ k: string }>(
    `SELECT DISTINCT consolidation_key AS k FROM ${table.consolidatedTable}
     WHERE ${where('', table.positive)}`
  );
  return new Set(rows.map((row) => row.k.toLowerCase()));
}

function walletsOf(key: string): string[] {
  return key.split('-').filter(Boolean);
}

async function sweepTable(
  table: SweptTable,
  expected: Set<string>,
  repair: boolean
): Promise<HoldingsKeySweepResult> {
  const stored = await storedKeys(table);
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
    await transferReconciliationDb.enqueueIfAbsent(toQueue, table.consumer);
  }
  return {
    consumer: table.consumer,
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
 * Each NFT token's total held by wallets against its total held by
 * consolidations, and all wallets' total balance against all consolidations'.
 * A wrong total under the right key shows here and not in the key check.
 */
async function checkSums(): Promise<HoldingsSumCheck> {
  const [tokens] = await sqlExecutor.execute<{
    compared: number | string;
    differing: number | string;
  }>(
    `SELECT COUNT(*) AS compared,
            COALESCE(SUM(COALESCE(w.total, 0) <> COALESCE(c.total, 0)), 0) AS differing
     FROM (
       SELECT LOWER(contract) AS contract, token_id FROM ${NFT_OWNERS_TABLE} WHERE balance > 0
       UNION
       SELECT LOWER(contract), token_id FROM ${NFT_OWNERS_CONSOLIDATION_TABLE} WHERE balance > 0
     ) t
     LEFT JOIN (
       SELECT LOWER(contract) AS contract, token_id, SUM(balance) AS total
       FROM ${NFT_OWNERS_TABLE} WHERE balance > 0 GROUP BY LOWER(contract), token_id
     ) w ON w.contract = t.contract AND w.token_id = t.token_id
     LEFT JOIN (
       SELECT LOWER(contract) AS contract, token_id, SUM(balance) AS total
       FROM ${NFT_OWNERS_CONSOLIDATION_TABLE} WHERE balance > 0 GROUP BY LOWER(contract), token_id
     ) c ON c.contract = t.contract AND c.token_id = t.token_id`
  );
  const [balances] = await sqlExecutor.execute<{
    wallets: number | string | null;
    consolidated: number | string | null;
  }>(
    `SELECT
       (SELECT SUM(total_balance) FROM ${OWNERS_BALANCES_TABLE} WHERE total_balance > 0) AS wallets,
       (SELECT SUM(total_balance) FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE} WHERE total_balance > 0) AS consolidated`
  );
  return {
    nft_tokens_compared: Number(tokens?.compared ?? 0),
    nft_tokens_differing: Number(tokens?.differing ?? 0),
    wallet_total_balance: Number(balances?.wallets ?? 0),
    consolidated_total_balance: Number(balances?.consolidated ?? 0)
  };
}

/**
 * Compares each consolidated holdings table with the keys its wallets map to
 * in address_consolidation_keys: stale keys, missing keys, and a wallet
 * stored under two keys. With `repair`, queues those wallets for the loop
 * that writes the table; a wallet already queued is left as it is. Without
 * it, only reports, and also compares the grouped totals with the wallets'.
 */
export async function sweepHoldingsKeys({
  repair
}: {
  repair: boolean;
}): Promise<HoldingsKeySweepReport> {
  const expectedBySource = new Map<KeySource, Set<string>>();
  const tables: HoldingsKeySweepResult[] = [];
  for (const table of SWEPT) {
    let expected = expectedBySource.get(table.expected);
    if (!expected) {
      expected = await expectedKeys(table.expected);
      expectedBySource.set(table.expected, expected);
    }
    tables.push(await sweepTable(table, expected, repair));
  }
  const sums = repair ? null : await checkSums();
  const mismatched =
    tables.some((result) => result.wallets_to_queue > 0) ||
    (sums !== null &&
      (sums.nft_tokens_differing > 0 ||
        sums.wallet_total_balance !== sums.consolidated_total_balance));
  const report = { tables, sums };
  if (mismatched) {
    logger.warn({
      message: '[HOLDINGS KEY SWEEP: MISMATCHES]',
      repair,
      ...report
    });
  } else {
    logger.info({ message: '[HOLDINGS KEY SWEEP: CLEAN]', repair, ...report });
  }
  return report;
}
