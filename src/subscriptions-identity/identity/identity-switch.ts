import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTIONS_IDENTITY_SWITCH');

export const IDENTITY_FROM_ENV = 'FEATURE_SUBSCRIPTIONS_IDENTITY_FROM';
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

export interface OpeningState {
  readonly opening_sha256: string;
  readonly verified_at: number | null;
  readonly suspended_at: number | null;
}

export type SwitchReason =
  | 'FLAG_UNSET'
  | 'FLAG_INVALID'
  | 'BEFORE_SWITCH_TIME'
  | 'NOT_LOADED'
  | 'NOT_VERIFIED'
  | 'SUSPENDED'
  | 'IDENTITY_TABLES';

export interface SwitchStatus {
  /** The identity tables are the truth. */
  readonly identityTables: boolean;
  readonly reason: SwitchReason;
  readonly fromMs: number | null;
  readonly openingSha256: string | null;
}

async function readOpeningState(): Promise<OpeningState | null> {
  const [row] = await sqlExecutor.execute<OpeningState>(
    `SELECT opening_sha256, verified_at, suspended_at
       FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID }
  );
  return row
    ? {
        opening_sha256: row.opening_sha256,
        verified_at: row.verified_at === null ? null : Number(row.verified_at),
        suspended_at:
          row.suspended_at === null ? null : Number(row.suspended_at)
      }
    : null;
}

/**
 * Whether the identity-keyed subscription tables are the truth. They are
 * once FEATURE_SUBSCRIPTIONS_IDENTITY_FROM (an ISO time) has passed and the
 * opening file is loaded and verified, and not after a rollback.
 *
 * Rollback is one step for every lambda: `suspend` sets suspended_at on the
 * opening state, and each reader re-reads that row at least every 60
 * seconds. Clearing the flag also rolls back, lambda by lambda as each is
 * redeployed. Going forward again needs a new cut and load, since the
 * legacy tables moved on while suspended.
 */
export class SubscriptionsIdentitySwitch {
  private cache: { state: OpeningState | null; readAtMs: number } | null = null;
  private warnedInvalid: string | null = null;

  constructor(
    private readonly readState: () => Promise<OpeningState | null> = readOpeningState,
    private readonly now: () => number = () => Date.now(),
    private readonly flag: () => string | undefined = () =>
      process.env[IDENTITY_FROM_ENV],
    private readonly shadowFlag: () => string | undefined = () =>
      process.env[SHADOW_ENV]
  ) {}

  /** The switch time from the flag: null when unset, NaN when not an ISO time. */
  fromMs(): number | null {
    const value = this.flag()?.trim();
    if (!value) {
      return null;
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      if (this.warnedInvalid !== value) {
        this.warnedInvalid = value;
        logger.error(
          `[${IDENTITY_FROM_ENV} IS NOT AN ISO TIME] [${value}] [LEGACY TABLES STAY THE TRUTH]`
        );
      }
      return Number.NaN;
    }
    return ms;
  }

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
    const fromMs = this.fromMs();
    const base = {
      fromMs: fromMs === null || Number.isNaN(fromMs) ? null : fromMs
    };
    if (fromMs === null) {
      return {
        ...base,
        identityTables: false,
        reason: 'FLAG_UNSET',
        openingSha256: null
      };
    }
    if (Number.isNaN(fromMs)) {
      return {
        ...base,
        identityTables: false,
        reason: 'FLAG_INVALID',
        openingSha256: null
      };
    }
    if (this.now() < fromMs) {
      return {
        ...base,
        identityTables: false,
        reason: 'BEFORE_SWITCH_TIME',
        openingSha256: null
      };
    }
    const state = await this.state();
    const openingSha256 = state?.opening_sha256 ?? null;
    if (!state) {
      return {
        ...base,
        identityTables: false,
        reason: 'NOT_LOADED',
        openingSha256
      };
    }
    if (state.suspended_at !== null) {
      return {
        ...base,
        identityTables: false,
        reason: 'SUSPENDED',
        openingSha256
      };
    }
    if (state.verified_at === null) {
      return {
        ...base,
        identityTables: false,
        reason: 'NOT_VERIFIED',
        openingSha256
      };
    }
    return {
      ...base,
      identityTables: true,
      reason: 'IDENTITY_TABLES',
      openingSha256
    };
  }

  async writeMode(): Promise<IdentityWriteMode> {
    if ((await this.status()).identityTables) {
      return 'TRUTH';
    }
    if (this.shadowFlag() !== 'true') {
      return 'OFF';
    }
    const state = await this.state();
    return state && state.suspended_at === null ? 'SHADOW' : 'OFF';
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
