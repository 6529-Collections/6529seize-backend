import {
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTIONS_IDENTITY_SWITCH');

export const SHADOW_ENV = 'FEATURE_SUBSCRIPTIONS_SHADOW';

/**
 * Whether the identity writers keep the identity tables up to date:
 * TRUTH after the switch; SHADOW before it, with FEATURE_SUBSCRIPTIONS_SHADOW
 * on and an opening loaded, to be compared with the legacy tables; else OFF.
 */
export type IdentityWriteMode = 'OFF' | 'SHADOW' | 'TRUTH';
/** The opening state row's id. */
export const OPENING_STATE_ID = 'opening';
/** How long a reader trusts what it last read of the opening state. */
export const STATE_RE_READ_MS = 60 * 1000;
/**
 * The cut that becomes the truth must be taken at the switch: no earlier
 * than this before the switch time, so no person's change made in between
 * is left out of the identity tables.
 */
export const SWITCH_CUT_WINDOW_MS = 15 * 60 * 1000;

export interface OpeningState {
  readonly opening_sha256: string;
  readonly cut_at: number;
  readonly verified_at: number | null;
  readonly suspended_at: number | null;
  /** When the identity tables become the truth; set by the CLI. */
  readonly switch_at: number | null;
}

export type SwitchReason =
  | 'NOT_LOADED'
  | 'NO_SWITCH_TIME'
  | 'BEFORE_SWITCH_TIME'
  | 'SUSPENDED'
  | 'NOT_VERIFIED'
  | 'STALE_CUT'
  | 'IDENTITY_TABLES';

export interface SwitchStatus {
  /** The identity tables are the truth. */
  readonly identityTables: boolean;
  readonly reason: SwitchReason;
  readonly switchAtMs: number | null;
  readonly openingSha256: string | null;
}

const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/**
 * The state table or one of its columns isn't there yet (code deployed
 * before dbMigrationsLoop's schema sync): nothing is loaded.
 */
function isMissingSchema(error: unknown): boolean {
  const e = error as {
    code?: string;
    errno?: number;
    driverError?: { errno?: number };
  } | null;
  const errno = e?.errno ?? e?.driverError?.errno;
  return (
    e?.code === 'ER_NO_SUCH_TABLE' ||
    e?.code === 'ER_BAD_FIELD_ERROR' ||
    errno === 1146 ||
    errno === 1054
  );
}

async function readOpeningState(): Promise<OpeningState | null> {
  let rows: Record<string, unknown>[];
  try {
    rows = await sqlExecutor.execute<Record<string, unknown>>(
      `SELECT opening_sha256, cut_at, verified_at, suspended_at, switch_at
         FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
      { id: OPENING_STATE_ID }
    );
  } catch (error) {
    // Before dbMigrationsLoop has synced the table nothing is loaded.
    if (isMissingSchema(error)) {
      return null;
    }
    throw error;
  }
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row
    ? {
        opening_sha256: String(row.opening_sha256),
        cut_at: Number(row.cut_at),
        verified_at: numberOrNull(row.verified_at),
        suspended_at: numberOrNull(row.suspended_at),
        switch_at: numberOrNull(row.switch_at)
      }
    : null;
}

/** Whether a state makes the identity tables the truth at `nowMs`, and why. */
export function switchReason(
  state: OpeningState | null,
  nowMs: number
): SwitchReason {
  if (!state) {
    return 'NOT_LOADED';
  }
  if (state.switch_at === null) {
    return 'NO_SWITCH_TIME';
  }
  if (nowMs < state.switch_at) {
    return 'BEFORE_SWITCH_TIME';
  }
  if (state.suspended_at !== null) {
    return 'SUSPENDED';
  }
  if (state.verified_at === null) {
    return 'NOT_VERIFIED';
  }
  if (state.cut_at < state.switch_at - SWITCH_CUT_WINDOW_MS) {
    return 'STALE_CUT';
  }
  return 'IDENTITY_TABLES';
}

/**
 * Whether the identity-keyed subscription tables are the truth. That is one
 * row in the database, subscriptions_id_state, so one write moves every
 * service: the CLI's go-live sets its switch time after loading and
 * verifying a cut taken at the switch, and suspend rolls back.
 *
 * Each reader re-reads the row at least every 60 seconds, so a suspend
 * reaches every lambda within 60 seconds; API answers can be cached for
 * another minute, so allow about 2 minutes. Going forward again after a
 * suspend needs a new cut and load, since the legacy tables moved on.
 */
export class SubscriptionsIdentitySwitch {
  private cache: { state: OpeningState | null; readAtMs: number } | null = null;

  constructor(
    private readonly readState: () => Promise<OpeningState | null> = readOpeningState,
    private readonly now: () => number = () => Date.now(),
    private readonly shadowFlag: () => string | undefined = () =>
      process.env[SHADOW_ENV]
  ) {}

  private async state(): Promise<OpeningState | null> {
    const nowMs = this.now();
    if (this.cache && nowMs - this.cache.readAtMs < STATE_RE_READ_MS) {
      return this.cache.state;
    }
    try {
      const state = await this.readState();
      this.cache = { state, readAtMs: nowMs };
      return state;
    } catch (error) {
      logger.error('[OPENING STATE READ FAILED]', error);
      if (this.cache) {
        return this.cache.state;
      }
      throw error;
    }
  }

  async status(): Promise<SwitchStatus> {
    const state = await this.state();
    const reason = switchReason(state, this.now());
    return {
      identityTables: reason === 'IDENTITY_TABLES',
      reason,
      switchAtMs: state?.switch_at ?? null,
      openingSha256: state?.opening_sha256 ?? null
    };
  }

  async writeMode(): Promise<IdentityWriteMode> {
    const state = await this.state();
    if (switchReason(state, this.now()) === 'IDENTITY_TABLES') {
      return 'TRUTH';
    }
    if (this.shadowFlag() !== 'true') {
      return 'OFF';
    }
    return state && state.suspended_at === null ? 'SHADOW' : 'OFF';
  }

  /**
   * The mode, read again now (not from the cache), retried a few times;
   * throws if the state can't be read. For a run that must not guess: the
   * daily build, a phase pull, and a write route's check.
   */
  async writeModeOrFail(): Promise<IdentityWriteMode> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.cache = null;
      try {
        return await this.writeMode();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * The mode for a loop's identity writer, which catches up on its next
   * run: if the state can't be read and was never read, the legacy side
   * goes on alone (OFF), with an error logged.
   */
  async writeModeForLegacy(): Promise<IdentityWriteMode> {
    try {
      return await this.writeMode();
    } catch (error) {
      logger.error(
        '[IDENTITY WRITE MODE UNKNOWN] [LEGACY SIDE GOES ON]',
        error
      );
      return 'OFF';
    }
  }

  async identityTablesAreTruth(): Promise<boolean> {
    return (await this.status()).identityTables;
  }

  /** Forget the cached state (tests, and the CLI right after a change). */
  invalidate(): void {
    this.cache = null;
  }
}

export const subscriptionsIdentitySwitch = new SubscriptionsIdentitySwitch();

/** Rollback: every reader is back on the legacy tables within 60 seconds. */
export async function suspendIdentityTables(
  nowMs: number = Date.now()
): Promise<boolean> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET suspended_at = :nowMs
      WHERE id = :id AND suspended_at IS NULL`,
    { nowMs, id: OPENING_STATE_ID }
  );
  const [row] = await sqlExecutor.execute<{ suspended_at: number | null }>(
    `SELECT suspended_at FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID }
  );
  subscriptionsIdentitySwitch.invalidate();
  return !!row && row.suspended_at !== null;
}

/**
 * Sets the switch time on a verified, unsuspended load whose cut was taken
 * no earlier than SWITCH_CUT_WINDOW_MS before it. Returns false, changing
 * nothing, otherwise.
 */
export async function scheduleIdentitySwitch(
  switchAtMs: number,
  openingSha256: string
): Promise<boolean> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET switch_at = :switchAt
      WHERE id = :id AND opening_sha256 = :sha AND verified_at IS NOT NULL
        AND suspended_at IS NULL AND cut_at >= :earliestCut`,
    {
      switchAt: switchAtMs,
      id: OPENING_STATE_ID,
      sha: openingSha256,
      earliestCut: switchAtMs - SWITCH_CUT_WINDOW_MS
    }
  );
  const [row] = await sqlExecutor.execute<{ switch_at: number | null }>(
    `SELECT switch_at FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id AND opening_sha256 = :sha`,
    { id: OPENING_STATE_ID, sha: openingSha256 }
  );
  subscriptionsIdentitySwitch.invalidate();
  return !!row && Number(row.switch_at) === switchAtMs;
}

/**
 * The marker go-live sets before its cut and clears after the switch: while
 * it is there, the unsigned write routes answer 503, so no change lands
 * between the cut and the switch. It lives in subscriptions_id_cursors
 * (block holds the time it was set, in ms), which a load leaves alone.
 */
export const WRITES_CLOSED_ID = 'writes-closed';

export async function closeSubscriptionWrites(
  nowMs: number = Date.now()
): Promise<void> {
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_ID_CURSORS_TABLE} (id, block, updated_at)
      VALUES (:id, :nowMs, :nowMs)
      ON DUPLICATE KEY UPDATE block = VALUES(block), updated_at = VALUES(updated_at)`,
    { id: WRITES_CLOSED_ID, nowMs }
  );
}

export async function openSubscriptionWrites(): Promise<void> {
  await sqlExecutor.execute(
    `DELETE FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
    { id: WRITES_CLOSED_ID }
  );
}

export type UnsignedWrites = 'OPEN' | 'PAUSED' | 'SIGNED_ONLY';

/**
 * Whether the unsigned write routes may write, read uncached at the moment
 * of the write: PAUSED while go-live runs, SIGNED_ONLY once the identity
 * tables are the truth. Throws if the state can't be read, so a write is
 * refused rather than landing only in the legacy tables.
 */
export async function unsignedWritesNow(
  nowMs: number = Date.now()
): Promise<UnsignedWrites> {
  let closed: unknown[];
  try {
    closed = await sqlExecutor.execute(
      `SELECT id FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
      { id: WRITES_CLOSED_ID }
    );
  } catch (error) {
    if (!isMissingSchema(error)) {
      throw error;
    }
    closed = [];
  }
  if (Array.isArray(closed) && closed.length > 0) {
    return 'PAUSED';
  }
  const reason = switchReason(await readOpeningState(), nowMs);
  return reason === 'IDENTITY_TABLES' ? 'SIGNED_ONLY' : 'OPEN';
}
