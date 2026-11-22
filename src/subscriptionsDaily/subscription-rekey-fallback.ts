import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTIONS_REKEY_FALLBACK');

const CHUNK = 5000;
const STATE_ID = 'fallback';

/**
 * A run is due this long after the last one: every fifth run of the
 * one-minute top-up loop even when its start drifts, and the next run
 * after one is skipped or late.
 */
export const REKEY_FALLBACK_INTERVAL_MS = 4.5 * 60 * 1000;

/**
 * Above either limit a run changes nothing and alerts: that many stale keys
 * at once more likely means the mirror's table is partial than that people
 * regrouped their wallets.
 */
export const REKEY_FALLBACK_LIMITS = {
  maxStale: 50,
  maxShare: 0.05
} as const;

/** A key still stale after this many re-keys alerts, and then about hourly. */
export const REKEY_FALLBACK_STUCK_AFTER = 3;
const STUCK_ALERT_EVERY_RUNS = 12;
/** A halted run logs at most this many of its stale keys. */
const HALT_LOG_MAX_KEYS = 500;

export interface RekeyFallbackRun {
  /** Subscription balance keys checked. */
  readonly keys: number;
  /** Keys whose wallets the mirror now groups otherwise. */
  readonly stale: number;
  /** Of those, keys the key-width guard already holds a re-key for. */
  readonly waiting: number;
  /** Keys stale for the first time: logged now, re-keyed next run if still stale. */
  readonly firstSeen: number;
  /** Keys re-keyed in this run. */
  readonly rekeyed: number;
  /** Wallets passed to the legacy re-key. */
  readonly wallets: number;
  /** Keys still stale after REKEY_FALLBACK_STUCK_AFTER re-keys. */
  readonly stuck: number;
  /** Why the run stopped at a limit, changing nothing; null otherwise. */
  readonly halted: string | null;
}

/**
 * The legacy keys whose wallets no longer group that way: a key is stale
 * when the key address_consolidation_keys gives one of its wallets is not
 * the key itself. A wallet with no row there is skipped: while the mirror
 * rewrites the table, a missing row says nothing about the wallet.
 */
async function staleKeys(): Promise<{ keys: number; stale: string[] }> {
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
  return {
    keys: keys.length,
    stale: keys.filter((key) =>
      key.split('-').some((wallet) => {
        const mirrored = keyOfWallet.get(wallet);
        return mirrored !== undefined && mirrored !== key;
      })
    )
  };
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

/** Why this many stale keys stop a run, or null if they don't. */
export function rekeyHaltReason(
  stale: number,
  keys: number,
  limits: { readonly maxStale: number; readonly maxShare: number }
): string | null {
  if (stale > limits.maxStale) {
    return `${stale} stale keys, above the limit of ${limits.maxStale}`;
  }
  if (stale > keys * limits.maxShare) {
    return `${stale} of ${keys} keys stale, above ${limits.maxShare * 100}%`;
  }
  return null;
}

function parseRuns(value: unknown): Record<string, number> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object'
    ? (parsed as Record<string, number>)
    : {};
}

/**
 * Takes this run if the last one is at least REKEY_FALLBACK_INTERVAL_MS
 * old, so two loops never run it at once. Returns the stale keys' run
 * counts from the last run, or null when no run is due.
 */
async function claimRun(nowMs: number): Promise<Record<string, number> | null> {
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await sqlExecutor.execute(
      `INSERT IGNORE INTO ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE} (id, last_run_at, stale_runs)
        VALUES (:id, 0, '{}')`,
      { id: STATE_ID },
      options
    );
    const [state] = await sqlExecutor.execute<{
      last_run_at: number | string;
      stale_runs: unknown;
    }>(
      `SELECT last_run_at, stale_runs FROM ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE}
        WHERE id = :id FOR UPDATE`,
      { id: STATE_ID },
      options
    );
    if (nowMs - Number(state.last_run_at) < REKEY_FALLBACK_INTERVAL_MS) {
      return null;
    }
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE} SET last_run_at = :nowMs WHERE id = :id`,
      { nowMs, id: STATE_ID },
      options
    );
    return parseRuns(state.stale_runs);
  });
}

async function saveRuns(runs: Record<string, number>): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE} SET stale_runs = :runs WHERE id = :id`,
    { runs: JSON.stringify(runs), id: STATE_ID }
  );
}

/** Keys re-keyed REKEY_FALLBACK_STUCK_AFTER times or more and still stale. */
function stuckKeys(runs: Record<string, number>): string[] {
  // A key is re-keyed from its second run on, so before this run it was
  // re-keyed (runs - 2) times.
  return Object.keys(runs).filter(
    (key) => runs[key] - 2 >= REKEY_FALLBACK_STUCK_AFTER
  );
}

function alertStuck(stuck: string[], runs: Record<string, number>): void {
  const due = stuck.filter(
    (key) =>
      (runs[key] - 2 - REKEY_FALLBACK_STUCK_AFTER) % STUCK_ALERT_EVERY_RUNS ===
      0
  );
  if (due.length > 0) {
    logger.errorWithCode(
      'SUBSCRIPTIONS_REKEY_STUCK',
      `[REKEY FALLBACK STUCK] still stale after re-keys: ${due
        .map((key) => `${key} (${runs[key] - 2} re-keys)`)
        .join(', ')}`
    );
  }
}

/**
 * The re-key fallback (FEATURE_SUBSCRIPTIONS_REKEY_ON_MIRROR). The legacy
 * subscription tables are keyed by consolidation key, and today the
 * delegations loop re-keys them (consolidateSubscriptions) whenever it
 * changes a grouping. Once the identity mirror writes
 * address_consolidation_keys, a grouping can change with no delegation
 * event. This finds every subscription key whose wallets the mirror now
 * groups otherwise and makes the same call for their wallets, so the
 * legacy tables follow the mirror as they follow delegations today.
 *
 * Guards against a partial mirror table:
 * - a wallet with no row is skipped, not taken as its own key;
 * - above REKEY_FALLBACK_LIMITS stale keys the run logs them, alerts
 *   (SUBSCRIPTIONS_REKEY_HALTED) and changes nothing;
 * - a key is re-keyed only when it was stale on the run before too, so
 *   every key is logged a run before anything changes it.
 *
 * A key whose re-key the key-width guard already holds back is left to the
 * guard's replay. A key still stale after REKEY_FALLBACK_STUCK_AFTER
 * re-keys alerts (SUBSCRIPTIONS_REKEY_STUCK). Runs are spaced by the last
 * run's time (REKEY_FALLBACK_INTERVAL_MS); returns null when none is due.
 */
export async function rekeyStaleSubscriptions(
  rekey: (wallets: Set<string>) => Promise<unknown>,
  nowMs: number = Date.now(),
  limits: {
    readonly maxStale: number;
    readonly maxShare: number;
  } = REKEY_FALLBACK_LIMITS
): Promise<RekeyFallbackRun | null> {
  const previous = await claimRun(nowMs);
  if (previous === null) {
    return null;
  }
  const { keys, stale } = await staleKeys();
  const halted = rekeyHaltReason(stale.length, keys, limits);
  if (halted) {
    // Every key starts over once the table looks whole again.
    await saveRuns({});
    const listed = stale.slice(0, HALT_LOG_MAX_KEYS).join(', ');
    const more =
      stale.length > HALT_LOG_MAX_KEYS
        ? ` and ${stale.length - HALT_LOG_MAX_KEYS} more`
        : '';
    logger.errorWithCode(
      'SUBSCRIPTIONS_REKEY_HALTED',
      `[REKEY FALLBACK HALTED] ${halted}; nothing re-keyed. Stale keys: ${listed}${more}`
    );
    return {
      keys,
      stale: stale.length,
      waiting: 0,
      firstSeen: 0,
      rekeyed: 0,
      wallets: 0,
      stuck: 0,
      halted
    };
  }
  const held = stale.length > 0 ? await heldBackKeys() : new Set<string>();
  const runs: Record<string, number> = {};
  for (const key of stale.filter((k) => !held.has(k))) {
    runs[key] = (previous[key] ?? 0) + 1;
  }
  await saveRuns(runs);
  const firstSeen = Object.keys(runs).filter((key) => runs[key] === 1);
  const ready = Object.keys(runs).filter((key) => runs[key] > 1);
  const stuck = stuckKeys(runs);
  alertStuck(stuck, runs);
  const wallets = new Set(
    ready.flatMap((key) => key.split('-')).filter(Boolean)
  );
  const run: RekeyFallbackRun = {
    keys,
    stale: stale.length,
    waiting: stale.length - Object.keys(runs).length,
    firstSeen: firstSeen.length,
    rekeyed: ready.length,
    wallets: wallets.size,
    stuck: stuck.length,
    halted: null
  };
  if (run.stale === 0) {
    return run;
  }
  logger.info(
    `[REKEY FALLBACK] ${JSON.stringify(run)}${
      firstSeen.length > 0
        ? ` stale for the first time, re-keyed next run if still stale: ${firstSeen.join(', ')}.`
        : ''
    }${ready.length > 0 ? ` re-keying: ${ready.join(', ')}.` : ''}`
  );
  if (wallets.size > 0) {
    await rekey(wallets);
  }
  return run;
}
