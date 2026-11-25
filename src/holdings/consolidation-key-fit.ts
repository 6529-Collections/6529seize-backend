import { Logger } from '@/logging';
import { metricEnvironment } from '@/metric-environment';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import {
  TransferConsumer,
  transferReconciliationDb
} from '@/transactions/transfer-reconciliation.db';

const logger = Logger.get('CONSOLIDATION_KEY_FIT');

// The widening migration may deploy while a container is warm.
const WIDTH_CACHE_MILLIS = Time.minutes(10).toMillis();
// Every holdings key column has been at least this wide, so keys up to this
// length (4 wallets) need no schema read.
const NARROWEST_KEY_COLUMN = 200;

const widthCache = new Map<string, { width: number; readAt: number }>();

async function liveKeyWidth(table: string): Promise<number> {
  const cached = widthCache.get(table);
  const now = Time.currentMillis();
  if (cached && now - cached.readAt < WIDTH_CACHE_MILLIS) return cached.width;
  const rows = await sqlExecutor.execute<{ width: number | string | null }>(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS width FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = :table
       AND column_name = 'consolidation_key'`,
    { table }
  );
  const width = Number(rows[0]?.width);
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`No consolidation_key column found on ${table}`);
  }
  widthCache.set(table, { width, readAt: now });
  return width;
}

/** EMF count of deferred wallets; outside Lambda the warning log is the signal. */
function emitDeferredMetric(consumer: TransferConsumer, wallets: number) {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/Holdings',
              Dimensions: [['Environment', 'Consumer']],
              Metrics: [
                { Name: 'ConsolidationKeyDeferredWallets', Unit: 'Count' }
              ]
            }
          ]
        },
        Environment: metricEnvironment(),
        Consumer: consumer,
        ConsolidationKeyDeferredWallets: wallets
      })}\n`
    );
  } catch {
    // Metrics never change the outcome.
  }
}

/**
 * A guard for the window before the key columns are widened. Holdings read
 * their keys from address_consolidation_keys, which the widening migration
 * widens last, so in practice a key longer than a holdings column only
 * arrives here if a holdings table is narrower than that table (a partial
 * manual change, or a table restored from an older backup).
 *
 * A group whose key doesn't fit the tables a loop writes is left out of that
 * write and logged, and its wallets go to the tail of the loop's queue, so
 * the group is written once the columns are wide. Its stored rows are not
 * written either, with two exceptions: a reset deletes every row first, and
 * a fitting group's write deletes any stored key that holds one of its
 * wallets, including a key a deferred wallet shared. Until the columns are
 * wide those deferred wallets have no consolidated row. Returns the groups
 * that fit.
 */
export async function deferGroupsThatDoNotFit(
  groups: Map<string, string[]>,
  tables: readonly string[],
  consumer: TransferConsumer
): Promise<Map<string, string[]>> {
  // A loop, not Math.max(...keys): a reset passes every group at once.
  let longest = 0;
  groups.forEach((_, key) => {
    longest = Math.max(longest, key.length);
  });
  if (longest <= NARROWEST_KEY_COLUMN) return groups;
  let width = Infinity;
  for (const table of tables)
    width = Math.min(width, await liveKeyWidth(table));
  if (longest <= width) return groups;

  const fitting = new Map<string, string[]>();
  const deferredWallets: string[] = [];
  groups.forEach((wallets, key) => {
    if (key.length <= width) {
      fitting.set(key, wallets);
      return;
    }
    deferredWallets.push(...wallets);
    logger.warn({
      message: '[CONSOLIDATION KEY DOES NOT FIT: DEFERRED]',
      consumer,
      tables,
      key_length: key.length,
      column_width: width,
      wallets: wallets.length
    });
  });
  await transferReconciliationDb.requeue(deferredWallets, consumer);
  emitDeferredMetric(consumer, deferredWallets.length);
  return fitting;
}
