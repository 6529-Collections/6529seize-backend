import {
  SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE,
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTION_KEY_WIDTH');

/** The key column's width before the key-width migration. */
export const SUBSCRIPTION_KEY_FALLBACK_WIDTH = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

/** Every subscription table with a `consolidation_key` column. */
const SUBSCRIPTION_KEY_TABLES = [
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE,
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE
] as const;

export interface NarrowColumn {
  readonly table: string;
  readonly width: number;
}

type WidthLoader = () => Promise<Map<string, number>>;

/**
 * The widths have never been read in this process, so a key over the old
 * 200 characters can't be judged: the write fails, to be retried, rather
 * than being held back for a reason that may not be true.
 */
export class SubscriptionKeyWidthsUnknownError extends Error {
  constructor(keyLength: number) {
    super(
      `Subscription key column widths are unknown; a key of ${keyLength} characters can't be written or held back yet`
    );
    // The ES5 target loses the subclass on Error unless it is set back.
    Object.setPrototypeOf(this, SubscriptionKeyWidthsUnknownError.prototype);
    this.name = 'SubscriptionKeyWidthsUnknownError';
  }
}

/**
 * The width of each subscription table's key column, read from the
 * database's own catalogue and cached, so writers follow the key-width
 * migration as soon as it is applied. A table the catalogue does not list
 * counts as the old width of 200. A failed read keeps the last widths read
 * and is retried a minute later. If no read has ever worked in this process,
 * keys of up to 200 characters (which fit any version of the tables) go on,
 * and a longer key throws SubscriptionKeyWidthsUnknownError.
 */
export class SubscriptionKeyWidths {
  private cache: {
    widths: Map<string, number>;
    known: boolean;
    expiresAtMs: number;
  } | null = null;
  private lastGood: Map<string, number> | null = null;

  constructor(
    private readonly load: WidthLoader,
    private readonly now: () => number = () => Date.now()
  ) {}

  async widthOf(table: string): Promise<number> {
    const { widths } = await this.widths();
    return widths.get(table) ?? SUBSCRIPTION_KEY_FALLBACK_WIDTH;
  }

  /** The narrowest key column among `tables`. */
  async minWidth(tables: readonly string[]): Promise<number> {
    let width = Number.POSITIVE_INFINITY;
    for (const table of tables) {
      width = Math.min(width, await this.widthOf(table));
    }
    return width;
  }

  /**
   * The tables whose key column is too narrow for `key`. Throws
   * SubscriptionKeyWidthsUnknownError for a key over 200 characters while
   * the widths have never been read.
   */
  async narrowFor(
    key: string,
    tables: readonly string[]
  ): Promise<NarrowColumn[]> {
    const { known } = await this.widths();
    if (!known && key.length > SUBSCRIPTION_KEY_FALLBACK_WIDTH) {
      throw new SubscriptionKeyWidthsUnknownError(key.length);
    }
    const narrow: NarrowColumn[] = [];
    for (const table of tables) {
      const width = await this.widthOf(table);
      if (key.length > width) {
        narrow.push({ table, width });
      }
    }
    return narrow;
  }

  async fits(key: string, tables: readonly string[]): Promise<boolean> {
    return (await this.narrowFor(key, tables)).length === 0;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async widths(): Promise<{
    widths: Map<string, number>;
    known: boolean;
  }> {
    if (this.cache && this.cache.expiresAtMs > this.now()) {
      return this.cache;
    }
    try {
      const widths = await this.load();
      this.lastGood = widths;
      this.cache = {
        widths,
        known: true,
        expiresAtMs: this.now() + CACHE_TTL_MS
      };
    } catch (error) {
      logger.warn(
        this.lastGood
          ? 'Could not read the subscription key column widths; keeping the last widths read'
          : `Could not read the subscription key column widths; keys over ${SUBSCRIPTION_KEY_FALLBACK_WIDTH} characters wait for a read`,
        error
      );
      this.cache = {
        widths: this.lastGood ?? new Map(),
        known: this.lastGood !== null,
        expiresAtMs: this.now() + FAILURE_TTL_MS
      };
    }
    return this.cache;
  }
}

async function loadFromCatalogue(): Promise<Map<string, number>> {
  const rows = await sqlExecutor.execute<{
    table_name: string;
    width: number | string | null;
  }>(
    `SELECT TABLE_NAME AS table_name, CHARACTER_MAXIMUM_LENGTH AS width
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND COLUMN_NAME = 'consolidation_key'
        AND TABLE_NAME IN (:tables)`,
    { tables: [...SUBSCRIPTION_KEY_TABLES] }
  );
  const widths = new Map<string, number>();
  for (const row of rows) {
    const width = Number(row.width);
    if (Number.isSafeInteger(width) && width > 0) {
      widths.set(row.table_name.toLowerCase(), width);
    }
  }
  return widths;
}

export const subscriptionKeyWidths = new SubscriptionKeyWidths(
  loadFromCatalogue
);
