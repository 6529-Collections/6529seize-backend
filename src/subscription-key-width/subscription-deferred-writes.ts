import { randomUUID } from 'node:crypto';
import {
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { NarrowColumn, subscriptionKeyWidths } from './subscription-key-width';

const logger = Logger.get('SUBSCRIPTION_DEFERRED_WRITES');

export type DeferredWriteKind =
  | 'TOP_UP'
  | 'SUBSCRIPTION'
  | 'SUBSCRIPTION_COUNT'
  | 'MODE'
  | 'ALL_EDITIONS'
  | 'AUTO_SUBSCRIPTION'
  | 'FINAL_ROW'
  | 'LOG'
  | 'REDEMPTION'
  | 'CONSOLIDATION';

/** The tables each kind of write puts the key into. */
export const DEFERRED_WRITE_TABLES: Readonly<
  Record<DeferredWriteKind, readonly string[]>
> = {
  TOP_UP: [
    SUBSCRIPTIONS_BALANCES_TABLE,
    SUBSCRIPTIONS_MODE_TABLE,
    SUBSCRIPTIONS_LOGS_TABLE
  ],
  SUBSCRIPTION: [SUBSCRIPTIONS_NFTS_TABLE, SUBSCRIPTIONS_LOGS_TABLE],
  SUBSCRIPTION_COUNT: [SUBSCRIPTIONS_NFTS_TABLE, SUBSCRIPTIONS_LOGS_TABLE],
  MODE: [SUBSCRIPTIONS_MODE_TABLE, SUBSCRIPTIONS_LOGS_TABLE],
  ALL_EDITIONS: [SUBSCRIPTIONS_MODE_TABLE, SUBSCRIPTIONS_LOGS_TABLE],
  AUTO_SUBSCRIPTION: [SUBSCRIPTIONS_NFTS_TABLE],
  FINAL_ROW: [SUBSCRIPTIONS_NFTS_FINAL_TABLE],
  LOG: [SUBSCRIPTIONS_LOGS_TABLE],
  REDEMPTION: [
    SUBSCRIPTIONS_BALANCES_TABLE,
    SUBSCRIPTIONS_REDEEMED_TABLE,
    SUBSCRIPTIONS_NFTS_FINAL_TABLE
  ],
  CONSOLIDATION: [
    SUBSCRIPTIONS_BALANCES_TABLE,
    SUBSCRIPTIONS_MODE_TABLE,
    SUBSCRIPTIONS_NFTS_TABLE,
    SUBSCRIPTIONS_NFTS_FINAL_TABLE,
    SUBSCRIPTIONS_LOGS_TABLE,
    SUBSCRIPTIONS_REDEEMED_TABLE
  ]
};

/** The tables too narrow for this kind of write of `key`; empty if it fits. */
export function narrowColumnsFor(
  kind: DeferredWriteKind,
  key: string
): Promise<NarrowColumn[]> {
  return subscriptionKeyWidths.narrowFor(key, DEFERRED_WRITE_TABLES[kind]);
}

export interface DeferredWrite {
  readonly kind: DeferredWriteKind;
  readonly consolidationKey: string;
  readonly payload: unknown;
  readonly narrow: readonly NarrowColumn[];
}

/** Runs one statement with `?` placeholders in the caller's transaction. */
export interface DeferredWriteSink {
  query(sql: string, values: unknown[]): Promise<unknown>;
}

function reasonOf(write: DeferredWrite): string {
  const columns = write.narrow
    .map((c) => `${c.table} holds ${c.width}`)
    .join(', ');
  return `key of ${write.consolidationKey.length} characters; ${columns}`;
}

const INSERT_SQL = `INSERT INTO ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
  (id, kind, consolidation_key, key_length, payload, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

function insertValues(write: DeferredWrite, nowMs: number): unknown[] {
  return [
    randomUUID(),
    write.kind,
    write.consolidationKey,
    write.consolidationKey.length,
    JSON.stringify(write.payload),
    reasonOf(write),
    nowMs
  ];
}

function logDeferred(write: DeferredWrite) {
  logger.errorWithCode(
    'SUBSCRIPTION_KEY_DEFERRED',
    `[SUBSCRIPTION WRITE DEFERRED] [${write.kind}] ${reasonOf(write)}`
  );
}

/**
 * Queues writes whose key does not fit, in the caller's transaction (so a
 * rolled-back batch leaves no queue entry behind), and logs each one.
 */
export async function deferSubscriptionWrites(
  writes: readonly DeferredWrite[],
  sink: DeferredWriteSink,
  nowMs: number = Date.now()
): Promise<void> {
  for (const write of writes) {
    await sink.query(INSERT_SQL, insertValues(write, nowMs));
    logDeferred(write);
  }
}

/** A sink over the SQL executor, optionally inside its transaction. */
export function executorSink(options?: DbQueryOptions): DeferredWriteSink {
  return {
    async query(sql, values) {
      let index = 0;
      const params: Record<string, unknown> = {};
      const named = sql.replace(/\?/g, () => {
        const name = `p${index}`;
        params[name] = values[index++];
        return `:${name}`;
      });
      return sqlExecutor.execute(named, params, options);
    }
  };
}

export interface PendingDeferredWrite {
  readonly id: string;
  readonly kind: DeferredWriteKind;
  readonly consolidation_key: string;
  readonly payload: unknown;
  readonly created_at: number;
}

export type ReplayOutcome = 'DONE' | 'SKIPPED';
export type DeferredWriteReplayer = (
  write: PendingDeferredWrite
) => Promise<ReplayOutcome>;

export interface ReplaySummary {
  readonly done: number;
  readonly skipped: number;
  readonly waiting: number;
  readonly failed: number;
}

function parsePayload(payload: unknown): unknown {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

/**
 * Replays queued writes whose key now fits every table the write needs, in
 * the order they were queued. Each replayer makes the original write through
 * the original code path, and says SKIPPED when the write no longer applies
 * (for example the card has already dropped). An entry whose key still does
 * not fit waits; one whose replay throws stays queued and is logged.
 */
export async function replayDeferredSubscriptionWrites(
  replayers: Partial<Record<DeferredWriteKind, DeferredWriteReplayer>>,
  params: { readonly limit?: number; readonly nowMs?: () => number } = {}
): Promise<ReplaySummary> {
  const now = params.nowMs ?? (() => Date.now());
  const pending = await sqlExecutor.execute<PendingDeferredWrite>(
    `SELECT id, kind, consolidation_key, payload, created_at
       FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
      WHERE replayed_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT :limit`,
    { limit: params.limit ?? 100 }
  );
  const summary = { done: 0, skipped: 0, waiting: 0, failed: 0 };
  for (const row of pending) {
    const write = { ...row, payload: parsePayload(row.payload) };
    const replayer = replayers[write.kind];
    if (
      !replayer ||
      (await narrowColumnsFor(write.kind, write.consolidation_key)).length > 0
    ) {
      summary.waiting++;
      continue;
    }
    try {
      const outcome = await replayer(write);
      await sqlExecutor.execute(
        `UPDATE ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
            SET replayed_at = :replayedAt, outcome = :outcome
          WHERE id = :id AND replayed_at IS NULL`,
        { replayedAt: now(), outcome, id: write.id }
      );
      summary[outcome === 'DONE' ? 'done' : 'skipped']++;
    } catch (error) {
      summary.failed++;
      logger.error(
        `[DEFERRED WRITE REPLAY FAILED] [${write.kind}] [${write.id}]`,
        error
      );
    }
  }
  return summary;
}
