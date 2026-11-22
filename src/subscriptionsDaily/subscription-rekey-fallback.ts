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

/** Stale keys above which a run stops: a count, and a percentage of the keys. */
export interface RekeyFallbackLimits {
  readonly maxStale: number;
  readonly maxStalePct: number;
}

/**
 * Above either limit a run changes nothing and alerts: that many stale keys
 * at once more likely means the mirror's table is partial than that people
 * regrouped their wallets. A planned regrouping (the identity switch-on)
 * raises them for a while through SUBSCRIPTIONS_REKEY_MAX_STALE and
 * SUBSCRIPTIONS_REKEY_MAX_STALE_PCT.
 */
export const REKEY_FALLBACK_LIMITS: RekeyFallbackLimits = {
  maxStale: 50,
  maxStalePct: 5
};

function limitFrom(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const limit = Number(value);
  return Number.isFinite(limit) && limit >= 0 ? limit : null;
}

/**
 * The limits in force: SUBSCRIPTIONS_REKEY_MAX_STALE and
 * SUBSCRIPTIONS_REKEY_MAX_STALE_PCT where set to a number of 0 or more,
 * else REKEY_FALLBACK_LIMITS.
 */
export function rekeyFallbackLimits(
  env: Readonly<Record<string, string | undefined>> = process.env
): RekeyFallbackLimits {
  return {
    maxStale:
      limitFrom(env.SUBSCRIPTIONS_REKEY_MAX_STALE) ??
      REKEY_FALLBACK_LIMITS.maxStale,
    maxStalePct:
      limitFrom(env.SUBSCRIPTIONS_REKEY_MAX_STALE_PCT) ??
      REKEY_FALLBACK_LIMITS.maxStalePct
  };
}

/** A key still stale after this many runs due to re-key it alerts, and then about hourly. */
export const REKEY_FALLBACK_STUCK_AFTER = 3;

/** A run holds a lease this long: the top-up loop's longest run (its timeout). */
export const REKEY_FALLBACK_LEASE_MS = 15 * 60 * 1000;
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
  /** Keys due for a re-key that wait: they, or a key sharing a wallet with them, have a wallet with no mirror row. */
  readonly partial: number;
  /** Wallets passed to the legacy re-key. */
  readonly wallets: number;
  /** Keys still stale after REKEY_FALLBACK_STUCK_AFTER runs due to re-key them. */
  readonly stuck: number;
  /** Why the run stopped at a limit, changing nothing; null otherwise. */
  readonly halted: string | null;
  /** The limits in force for this run. */
  readonly limits: RekeyFallbackLimits;
}

/** The mirror table's key for each of these wallets that has a row. */
async function mirrorKeysOf(
  wallets: readonly string[]
): Promise<Map<string, string>> {
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
  return keyOfWallet;
}

function walletsOf(keys: readonly string[]): string[] {
  return Array.from(
    new Set(keys.flatMap((key) => key.split('-')).filter(Boolean))
  );
}

async function balanceKeys(): Promise<string[]> {
  return (
    await sqlExecutor.execute<{ consolidation_key: string }>(
      `SELECT consolidation_key FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
    )
  ).map((row) => row.consolidation_key.toLowerCase());
}

/**
 * The legacy keys whose wallets no longer group that way: a key is stale
 * when the key address_consolidation_keys gives one of its wallets is not
 * the key itself. A wallet with no row there is skipped: while the mirror
 * rewrites the table, a missing row says nothing about the wallet.
 */
async function staleKeys(): Promise<{ keys: number; stale: string[] }> {
  const keys = await balanceKeys();
  const keyOfWallet = await mirrorKeysOf(walletsOf(keys));
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

/**
 * Of the keys due, those that can be re-keyed now, read just before the
 * call. consolidateSubscriptions re-keys every balance key that shares a
 * wallet with those passed, and takes a wallet with no mirror row as its
 * own key, which would split a balance off. So a key waits while it, or a
 * key sharing one of its wallets, has a wallet with no row.
 */
async function keysWholeInMirror(
  due: readonly string[]
): Promise<{ whole: string[]; partial: string[] }> {
  const keys = await balanceKeys();
  const keyOfWallet = await mirrorKeysOf(walletsOf(keys));
  const walletsOfKey = (key: string) => key.split('-').filter(Boolean);
  const blocked = new Set(
    keys
      .filter((key) => walletsOfKey(key).some((w) => !keyOfWallet.has(w)))
      .flatMap(walletsOfKey)
  );
  const whole = due.filter((key) =>
    walletsOfKey(key).every((w) => keyOfWallet.has(w) && !blocked.has(w))
  );
  return { whole, partial: due.filter((key) => !whole.includes(key)) };
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
  limits: RekeyFallbackLimits
): string | null {
  if (stale > limits.maxStale) {
    return `${stale} stale keys, above the limit of ${limits.maxStale}`;
  }
  if (stale * 100 > keys * limits.maxStalePct) {
    return `${stale} of ${keys} keys stale, above ${limits.maxStalePct}%`;
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
 * Takes a run if the last one is at least REKEY_FALLBACK_INTERVAL_MS old
 * and no run holds the lease. The lease lasts REKEY_FALLBACK_LEASE_MS, the
 * top-up loop's longest run, so a slow run and the next one never overlap,
 * and a run that died frees it when it lapses. Returns the stale keys' run
 * counts from the last run, or null when no run is due.
 */
async function claimRun(nowMs: number): Promise<Record<string, number> | null> {
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await sqlExecutor.execute(
      `INSERT IGNORE INTO ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE} (id, last_run_at, lease_until, stale_runs)
        VALUES (:id, 0, 0, '{}')`,
      { id: STATE_ID },
      options
    );
    const [state] = await sqlExecutor.execute<{
      last_run_at: number | string;
      lease_until: number | string;
      stale_runs: unknown;
    }>(
      `SELECT last_run_at, lease_until, stale_runs FROM ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE}
        WHERE id = :id FOR UPDATE`,
      { id: STATE_ID },
      options
    );
    if (
      nowMs - Number(state.last_run_at) < REKEY_FALLBACK_INTERVAL_MS ||
      Number(state.lease_until) > nowMs
    ) {
      return null;
    }
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE}
          SET last_run_at = :nowMs, lease_until = :leaseUntil
        WHERE id = :id`,
      { nowMs, leaseUntil: nowMs + REKEY_FALLBACK_LEASE_MS, id: STATE_ID },
      options
    );
    return parseRuns(state.stale_runs);
  });
}

async function releaseRun(nowMs: number): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE} SET lease_until = 0
      WHERE id = :id AND lease_until = :leaseUntil`,
    { id: STATE_ID, leaseUntil: nowMs + REKEY_FALLBACK_LEASE_MS }
  );
}

async function saveRuns(runs: Record<string, number>): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE} SET stale_runs = :runs WHERE id = :id`,
    { runs: JSON.stringify(runs), id: STATE_ID }
  );
}

/**
 * Runs a key has been due for a re-key and stayed stale: it is due from its
 * second stale run on, so before this run it was due (runs - 2) times.
 */
function dueRuns(runs: Record<string, number>, key: string): number {
  return runs[key] - 2;
}

/** Keys due for a re-key REKEY_FALLBACK_STUCK_AFTER runs or more, and still stale. */
function stuckKeys(runs: Record<string, number>): string[] {
  return Object.keys(runs).filter(
    (key) => dueRuns(runs, key) >= REKEY_FALLBACK_STUCK_AFTER
  );
}

function alertStuck(stuck: string[], runs: Record<string, number>): void {
  const due = stuck.filter(
    (key) =>
      (dueRuns(runs, key) - REKEY_FALLBACK_STUCK_AFTER) %
        STUCK_ALERT_EVERY_RUNS ===
      0
  );
  if (due.length > 0) {
    logger.errorWithCode(
      'SUBSCRIPTIONS_REKEY_STUCK',
      `[REKEY FALLBACK STUCK] still stale after the runs that were due to re-key them: ${due
        .map((key) => `${key} (${dueRuns(runs, key)} runs)`)
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
 * - above the limits in force (rekeyFallbackLimits) the run logs the stale
 *   keys, alerts (SUBSCRIPTIONS_REKEY_HALTED) and changes nothing;
 * - whatever the limits, a key is re-keyed only when it was stale on the
 *   run before too, so every key is logged a run before anything changes
 *   it;
 * - just before the re-key, a key with a wallet that has no row waits.
 *
 * A key whose re-key the key-width guard already holds back is left to the
 * guard's replay. A key still stale after REKEY_FALLBACK_STUCK_AFTER runs
 * that were due to re-key it alerts (SUBSCRIPTIONS_REKEY_STUCK). Runs are
 * spaced by the last run's time (REKEY_FALLBACK_INTERVAL_MS) and hold a
 * lease while they run; returns null when none is due.
 */
export async function rekeyStaleSubscriptions(
  rekey: (wallets: Set<string>) => Promise<unknown>,
  nowMs: number = Date.now(),
  limits: RekeyFallbackLimits = rekeyFallbackLimits()
): Promise<RekeyFallbackRun | null> {
  const previous = await claimRun(nowMs);
  if (previous === null) {
    return null;
  }
  try {
    return await runClaimed(previous, rekey, limits);
  } finally {
    await releaseRun(nowMs);
  }
}

async function runClaimed(
  previous: Record<string, number>,
  rekey: (wallets: Set<string>) => Promise<unknown>,
  limits: RekeyFallbackLimits
): Promise<RekeyFallbackRun> {
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
    const run: RekeyFallbackRun = {
      keys,
      stale: stale.length,
      waiting: 0,
      firstSeen: 0,
      rekeyed: 0,
      partial: 0,
      wallets: 0,
      stuck: 0,
      halted,
      limits
    };
    logger.errorWithCode(
      'SUBSCRIPTIONS_REKEY_HALTED',
      `[REKEY FALLBACK HALTED] ${JSON.stringify(run)} nothing re-keyed. Stale keys: ${listed}${more}`
    );
    return run;
  }
  const held = stale.length > 0 ? await heldBackKeys() : new Set<string>();
  const runs: Record<string, number> = {};
  for (const key of stale.filter((k) => !held.has(k))) {
    runs[key] = (previous[key] ?? 0) + 1;
  }
  await saveRuns(runs);
  const firstSeen = Object.keys(runs).filter((key) => runs[key] === 1);
  const due = Object.keys(runs).filter((key) => runs[key] > 1);
  const { whole, partial } =
    due.length > 0 ? await keysWholeInMirror(due) : { whole: [], partial: [] };
  const stuck = stuckKeys(runs);
  alertStuck(stuck, runs);
  const wallets = new Set(walletsOf(whole));
  const run: RekeyFallbackRun = {
    keys,
    stale: stale.length,
    waiting: stale.length - Object.keys(runs).length,
    firstSeen: firstSeen.length,
    rekeyed: whole.length,
    partial: partial.length,
    wallets: wallets.size,
    stuck: stuck.length,
    halted: null,
    limits
  };
  const lists = [
    firstSeen.length > 0
      ? `stale for the first time, re-keyed next run if still stale: ${firstSeen.join(', ')}.`
      : '',
    partial.length > 0
      ? `waiting for mirror rows of every wallet they share keys with: ${partial.join(', ')}.`
      : '',
    whole.length > 0 ? `re-keying: ${whole.join(', ')}.` : ''
  ].filter(Boolean);
  logger.info(
    `[REKEY FALLBACK] ${JSON.stringify(run)}${lists.map((l) => ` ${l}`).join('')}`
  );
  if (wallets.size > 0) {
    await rekey(wallets);
  }
  return run;
}
