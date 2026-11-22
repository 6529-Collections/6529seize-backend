import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTIONS_REKEY_FALLBACK');

const CHUNK = 5000;
/** The fallback runs on every fifth minute of the top-up loop's schedule. */
export const REKEY_FALLBACK_EVERY_MINUTES = 5;

export interface RekeyFallbackRun {
  /** Subscription keys whose wallets the mirror now groups otherwise. */
  readonly stale: number;
  /** Of those, keys the key-width guard already holds a re-key for. */
  readonly waiting: number;
  /** Wallets passed to the legacy re-key. */
  readonly wallets: number;
}

/**
 * The legacy keys whose wallets no longer group that way: a key is stale
 * when one of its wallets' key in address_consolidation_keys (a wallet with
 * no row is its own key) is not the key itself.
 */
async function staleKeys(): Promise<string[]> {
  const keys = (
    await sqlExecutor.execute<{ consolidation_key: string }>(
      `SELECT consolidation_key FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
    )
  ).map((row) => row.consolidation_key.toLowerCase());
  const wallets = Array.from(
    new Set(keys.flatMap((key) => key.split('-')).filter(Boolean))
  );
  const keyOfWallet = new Map<string, string>();
  for (let i = 0; i < wallets.length; i += CHUNK) {
    const rows = await sqlExecutor.execute<{
      address: string;
      consolidation_key: string;
    }>(
      `SELECT address, consolidation_key FROM ${ADDRESS_CONSOLIDATION_KEY}
        WHERE address IN (:chunk)`,
      { chunk: wallets.slice(i, i + CHUNK) }
    );
    for (const row of rows) {
      keyOfWallet.set(
        row.address.toLowerCase(),
        row.consolidation_key.toLowerCase()
      );
    }
  }
  return keys.filter((key) =>
    key.split('-').some((wallet) => (keyOfWallet.get(wallet) ?? wallet) !== key)
  );
}

/** Old keys of re-keys the key-width guard holds back, not yet replayed. */
async function heldBackKeys(): Promise<Set<string>> {
  const rows = await sqlExecutor.execute<{ payload: unknown }>(
    `SELECT payload FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
      WHERE kind = 'CONSOLIDATION' AND replayed_at IS NULL`
  );
  const held = new Set<string>();
  for (const row of rows) {
    const payload = (
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    ) as { oldKeys?: string[] };
    for (const key of payload.oldKeys ?? []) {
      held.add(key.toLowerCase());
    }
  }
  return held;
}

/**
 * The re-key fallback (FEATURE_SUBSCRIPTIONS_REKEY_ON_MIRROR). The legacy
 * subscription tables are keyed by consolidation key, and today the
 * delegations loop re-keys them (consolidateSubscriptions) whenever it
 * changes a grouping. Once the identity mirror writes
 * address_consolidation_keys, a grouping can change with no delegation
 * event. This finds every subscription key whose wallets the mirror now
 * groups otherwise and makes the same call for their wallets, so the
 * legacy tables follow the mirror as they follow delegations today. A key
 * whose re-key the key-width guard already holds back is left to the
 * guard's replay.
 */
export async function rekeyStaleSubscriptions(
  rekey: (wallets: Set<string>) => Promise<unknown>
): Promise<RekeyFallbackRun> {
  const stale = await staleKeys();
  if (stale.length === 0) {
    return { stale: 0, waiting: 0, wallets: 0 };
  }
  const held = await heldBackKeys();
  const toRekey = stale.filter((key) => !held.has(key));
  const wallets = new Set(toRekey.flatMap((key) => key.split('-')));
  if (wallets.size > 0) {
    await rekey(wallets);
  }
  const run = {
    stale: stale.length,
    waiting: stale.length - toRekey.length,
    wallets: wallets.size
  };
  logger.info(`[REKEY FALLBACK] ${JSON.stringify(run)}`);
  return run;
}

/** Whether this run of a one-minute loop is one of every fifth minute. */
export function isRekeyFallbackMinute(now: Date = new Date()): boolean {
  return now.getUTCMinutes() % REKEY_FALLBACK_EVERY_MINUTES === 0;
}
