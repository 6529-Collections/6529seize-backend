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
export const SUBSCRIPTION_KEY_TABLES = [
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

export type WidthLoader = () => Promise<Map<string, number>>;

/**
 * The width of each subscription table's key column, read from the
 * database's own catalogue and cached, so writers follow the key-width
 * migration as soon as it is applied. A table the catalogue does not list,
 * or a failed read, counts as the old width of 200.
 */
export class SubscriptionKeyWidths {
  private cache: { widths: Map<string, number>; expiresAtMs: number } | null =
    null;

  constructor(
    private readonly load: WidthLoader,
    private readonly now: () => number = () => Date.now()
  ) {}

  async widthOf(table: string): Promise<number> {
    const widths = await this.widths();
    return widths.get(table) ?? SUBSCRIPTION_KEY_FALLBACK_WIDTH;
  }

  /** The tables whose key column is too narrow for `key`. */
  async narrowFor(
    key: string,
    tables: readonly string[]
  ): Promise<NarrowColumn[]> {
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

  private async widths(): Promise<Map<string, number>> {
    if (this.cache && this.cache.expiresAtMs > this.now()) {
      return this.cache.widths;
    }
    try {
      const widths = await this.load();
      this.cache = { widths, expiresAtMs: this.now() + CACHE_TTL_MS };
    } catch (error) {
      logger.warn(
        `Could not read the subscription key column widths; using ${SUBSCRIPTION_KEY_FALLBACK_WIDTH}`,
        error
      );
      this.cache = {
        widths: new Map(),
        expiresAtMs: this.now() + FAILURE_TTL_MS
      };
    }
    return this.cache.widths;
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
