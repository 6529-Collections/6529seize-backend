import {
  MEMES_CONTRACT,
  NFTS_TABLE,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import { compareText } from '../engine/text-order';
import { walletsOfKey } from './opening-attribution';
import { OpeningCut } from './opening-file';

/** The database's own text for a datetime, exact to the microsecond. */
export const AS_TEXT = (column: string) =>
  `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;

/** A time in milliseconds as the database's datetime text (UTC). */
export function msToDbText(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000`;
}

/** The id the top-up loop keeps its last block under. */
const TOP_UP_LATEST_BLOCK_ID = 'subscription_top_up_latest_block';

export type Flag = number | string | boolean;

export const flag = (value: Flag): boolean =>
  value === true || value === 1 || value === '1';

/** A write the key-width guard holds back (subscription_deferred_writes). */
export interface QueueRow {
  readonly sequence: number | string;
  readonly kind: string;
  readonly consolidation_key: string;
  /** JSON text, or the parsed value. */
  readonly payload: unknown;
  readonly created_at: number | string;
}

export interface LegacyTables {
  readonly balances: Array<{
    consolidation_key: string;
    balance: number;
    created_at: string;
    updated_at: string;
  }>;
  readonly modes: Array<{
    consolidation_key: string;
    automatic: Flag;
    subscribe_all_editions: Flag;
    created_at: string;
    updated_at: string;
  }>;
  readonly choices: Array<{
    consolidation_key: string;
    contract: string;
    token_id: number | string;
    subscribed: Flag;
    subscribed_count: number;
    automatic_subscription: Flag;
    created_at: string;
    updated_at: string;
  }>;
  readonly topUps: Array<{
    hash: string;
    block: number;
    transaction_date: string;
    from_wallet: string;
    amount: number;
    created_at: string;
  }>;
  readonly finalRows: Array<{
    /** The row id; other logs (the mint log's phases) refer to it. */
    id: number | string;
    consolidation_key: string;
    contract: string;
    token_id: number | string;
    subscribed_count: number;
    airdrop_address: string;
    balance: number;
    subscribed_at: string | null;
    phase: string | null;
    phase_subscriptions: number;
    phase_position: number;
    redeemed_count: number;
    created_at: string;
    updated_at: string;
  }>;
  readonly uploads: Array<{
    contract: string;
    token_id: number | string;
    date: string;
    upload_url: string;
    created_at: string;
  }>;
  readonly redeemed: Array<{
    consolidation_key: string;
    contract: string;
    token_id: number | string;
    address: string;
    transaction: string;
    transaction_date: string | null;
    value: number;
    balance_after: number;
    count: number;
    created_at: string;
  }>;
  readonly logs: Array<{
    id: number | string;
    consolidation_key: string;
    log: string;
    additional_info: string | null;
    created_at: string;
  }>;
  /** Writes still waiting in the key-width guard's queue. */
  readonly queue: QueueRow[];
}

function isMissingTable(error: unknown): boolean {
  const e = error as {
    code?: string;
    errno?: number;
    driverError?: { code?: string; errno?: number };
  } | null;
  return (
    e?.code === 'ER_NO_SUCH_TABLE' ||
    e?.errno === 1146 ||
    e?.driverError?.errno === 1146
  );
}

/** Reads the cut's markers and every legacy table, in the caller's transaction. */
export async function readLegacyTables(options: DbQueryOptions): Promise<{
  cut: Omit<OpeningCut, 'at' | 'mintPrice'>;
  tables: LegacyTables;
}> {
  const q = <T>(sql: string, params?: Record<string, unknown>) =>
    sqlExecutor.execute<T>(sql, params, options);
  const [maxMeme] = await q<{ id: number | null }>(
    `SELECT MAX(id) AS id FROM ${NFTS_TABLE} WHERE contract = :contract`,
    { contract: MEMES_CONTRACT }
  );
  const [topUpBlock] = await q<{ block: number }>(
    `SELECT block FROM ${SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_TABLE} WHERE id = :id`,
    { id: TOP_UP_LATEST_BLOCK_ID }
  );
  const [redemptionBlock] = await q<{ block: number | null }>(
    `SELECT MAX(block) AS block FROM ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE}`
  );
  let queue: QueueRow[] = [];
  try {
    queue = await q<QueueRow>(
      `SELECT sequence, kind, consolidation_key, payload, created_at
         FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        WHERE replayed_at IS NULL
        ORDER BY sequence ASC`
    );
  } catch (error) {
    if (!isMissingTable(error)) {
      throw error;
    }
  }
  const tables: LegacyTables = {
    balances: await q(
      `SELECT consolidation_key, balance, ${AS_TEXT('created_at')} AS created_at,
              ${AS_TEXT('updated_at')} AS updated_at
         FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
    ),
    modes: await q(
      `SELECT consolidation_key, automatic, subscribe_all_editions,
              ${AS_TEXT('created_at')} AS created_at, ${AS_TEXT('updated_at')} AS updated_at
         FROM ${SUBSCRIPTIONS_MODE_TABLE}`
    ),
    choices: await q(
      `SELECT consolidation_key, contract, token_id, subscribed, subscribed_count,
              automatic_subscription, ${AS_TEXT('created_at')} AS created_at,
              ${AS_TEXT('updated_at')} AS updated_at
         FROM ${SUBSCRIPTIONS_NFTS_TABLE}`
    ),
    topUps: await q(
      `SELECT hash, block, ${AS_TEXT('transaction_date')} AS transaction_date,
              from_wallet, amount, ${AS_TEXT('created_at')} AS created_at
         FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
    ),
    finalRows: await q(
      `SELECT id, consolidation_key, contract, token_id, subscribed_count, airdrop_address,
              balance, subscribed_at, phase, phase_subscriptions, phase_position,
              redeemed_count, ${AS_TEXT('created_at')} AS created_at,
              ${AS_TEXT('updated_at')} AS updated_at
         FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
    ),
    uploads: await q(
      `SELECT contract, token_id, date, upload_url, ${AS_TEXT('created_at')} AS created_at
         FROM ${SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE}`
    ),
    redeemed: await q(
      `SELECT consolidation_key, contract, token_id, address, \`transaction\`,
              ${AS_TEXT('transaction_date')} AS transaction_date, value, balance_after,
              count, ${AS_TEXT('created_at')} AS created_at
         FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`
    ),
    logs: await q(
      `SELECT id, consolidation_key, log, additional_info,
              ${AS_TEXT('created_at')} AS created_at
         FROM ${SUBSCRIPTIONS_LOGS_TABLE}`
    ),
    queue
  };
  return {
    cut: {
      maxMemeId: Number(maxMeme?.id ?? 0),
      topUpBlock: topUpBlock ? Number(topUpBlock.block) : null,
      redemptionBlock:
        redemptionBlock?.block === null || redemptionBlock === undefined
          ? null
          : Number(redemptionBlock.block)
    },
    tables
  };
}

export function queuePayload<T>(row: QueueRow): T {
  return (
    typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  ) as T;
}

/** A waiting top-up's payload, as the top-up loop queued it. */
export interface QueuedTopUp {
  readonly hash: string;
  readonly block: number;
  /** ISO, as JSON wrote the Date. */
  readonly transaction_date: string;
  readonly from_wallet: string;
  readonly amount: number;
}

/** Every wallet the tables name: in keys, as senders and as airdrop addresses. */
export function walletsInTables(tables: LegacyTables): string[] {
  const wallets = new Set<string>();
  const addKey = (key: string) =>
    walletsOfKey(key).forEach((w) => wallets.add(w));
  tables.balances.forEach((r) => addKey(r.consolidation_key));
  tables.modes.forEach((r) => addKey(r.consolidation_key));
  tables.choices.forEach((r) => addKey(r.consolidation_key));
  tables.finalRows.forEach((r) => {
    addKey(r.consolidation_key);
    wallets.add(r.airdrop_address.toLowerCase());
  });
  tables.redeemed.forEach((r) => {
    addKey(r.consolidation_key);
    wallets.add(r.address.toLowerCase());
  });
  tables.logs.forEach((r) => addKey(r.consolidation_key));
  tables.topUps.forEach((r) => wallets.add(r.from_wallet.toLowerCase()));
  tables.queue.forEach((r) => {
    addKey(r.consolidation_key);
    if (r.kind === 'TOP_UP') {
      const { topUp } = queuePayload<{ topUp: QueuedTopUp }>(r);
      wallets.add(topUp.from_wallet.toLowerCase());
    }
  });
  return Array.from(wallets).sort(compareText);
}
