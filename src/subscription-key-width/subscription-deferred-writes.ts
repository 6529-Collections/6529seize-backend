import { createHash } from 'node:crypto';
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
import { env } from '@/env';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { NarrowColumn, subscriptionKeyWidths } from './subscription-key-width';

const logger = Logger.get('SUBSCRIPTION_DEFERRED_WRITES');

export type DeferredWriteKind =
  | 'TOP_UP'
  | 'AUTO_SUBSCRIPTION'
  | 'FINAL_ROW'
  | 'LOG'
  | 'REDEMPTION'
  | 'CONSOLIDATION';

/**
 * Every subscription table that stores the key. A key is written only when
 * all of them can hold it, so an identity is either fully on the legacy
 * tables or fully waiting: never listed without being charged.
 */
export const SUBSCRIPTION_WRITE_TABLES = [
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
];

/** A wallet is 42 characters and keys join wallets with "-". */
const KEY_CHARACTERS_PER_WALLET = 43;

/** Runs one statement with `?` placeholders, in the caller's transaction. */
export interface DeferredWriteSink {
  query(sql: string, values: unknown[]): Promise<unknown>;
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyHash(key: string): string {
  return sha256(key.toLowerCase());
}

export interface DeferralReason {
  /** The subscription tables too narrow for the key. */
  readonly narrow: readonly NarrowColumn[];
  /** The key has an earlier write still waiting. */
  readonly pendingEarlier: boolean;
}

/** MySQL's "table doesn't exist", however the driver wraps it. */
function isMissingTable(error: unknown): boolean {
  const e = error as {
    code?: string;
    errno?: number;
    driverError?: { code?: string; errno?: number };
  } | null;
  return (
    e?.code === 'ER_NO_SUCH_TABLE' ||
    e?.errno === 1146 ||
    e?.driverError?.code === 'ER_NO_SUCH_TABLE' ||
    e?.driverError?.errno === 1146
  );
}

/**
 * Whether the key has a write waiting. Before dbMigrationsLoop has created
 * the queue table nothing can be waiting, so a missing table reads as none
 * and writes for keys that fit go on as before.
 *
 * With `locking`, for a writer's transaction, the read is FOR SHARE. A
 * plain read there returns the snapshot from the transaction's first plain
 * read, which misses a write queued for the key since, and the writer
 * would go ahead of it. The locking read returns the latest committed
 * entries and, until the writer commits, holds back any new entry where
 * this key's would go.
 */
async function hasPendingWrite(
  key: string,
  sink: DeferredWriteSink,
  beforeSequence: number | undefined,
  locking: boolean
): Promise<boolean> {
  let rows: unknown;
  try {
    rows = await sink.query(
      `SELECT sequence FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        WHERE key_hash = ? AND replayed_at IS NULL${
          beforeSequence === undefined ? '' : ' AND sequence < ?'
        }
        LIMIT 1${locking ? ' FOR SHARE' : ''}`,
      beforeSequence === undefined
        ? [keyHash(key)]
        : [keyHash(key), beforeSequence]
    );
  } catch (error) {
    if (isMissingTable(error)) {
      return false;
    }
    throw error;
  }
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Why a write for `key` must wait, or null when it can be made now: the key
 * does not fit every subscription table, or the key has an earlier write
 * still waiting (one key's writes keep their order). A replayed entry passes
 * its own sequence so only writes queued before it count.
 *
 * A caller that checks inside its own transaction and then writes passes
 * `locking`, so the waiting writes are read FOR SHARE. A check outside a
 * transaction (the API's, the daily final-list split) leaves it off: there
 * a lock would end with the statement, and the read may go to a read
 * replica.
 */
export async function deferralReason(
  key: string,
  sink: DeferredWriteSink,
  beforeSequence?: number,
  options: { readonly locking?: boolean } = {}
): Promise<DeferralReason | null> {
  const narrow = await subscriptionKeyWidths.narrowFor(
    key,
    SUBSCRIPTION_WRITE_TABLES
  );
  const pendingEarlier = await hasPendingWrite(
    key,
    sink,
    beforeSequence,
    options.locking ?? false
  );
  return narrow.length || pendingEarlier ? { narrow, pendingEarlier } : null;
}

/** The most wallets an identity can have and still fit every table. */
async function maxWalletsThatFit(): Promise<number> {
  const width = await subscriptionKeyWidths.minWidth(SUBSCRIPTION_WRITE_TABLES);
  return Math.floor((width + 1) / KEY_CHARACTERS_PER_WALLET);
}

function resumeText(): string {
  const resume = env.getStringOrNull('SUBSCRIPTIONS_WIDE_IDENTITY_RESUME_ON');
  return resume ? `on ${resume}` : 'after the identity switch';
}

/** What a person is told when their change can't be made yet. */
export async function deferralMessage(reason: DeferralReason): Promise<string> {
  if (reason.narrow.length) {
    return `Subscriptions for identities with more than ${await maxWalletsThatFit()} wallets resume ${resumeText()}.`;
  }
  return `Subscription changes for this identity resume once its earlier updates are applied, ${resumeText()}.`;
}

export interface DeferredWrite {
  readonly kind: DeferredWriteKind;
  readonly consolidationKey: string;
  /** What makes this write unique: a repeat replaces the queued payload. */
  readonly dedupe: string;
  readonly payload: unknown;
  readonly reason: DeferralReason;
}

function reasonText(write: DeferredWrite): string {
  const parts = write.reason.narrow.map((c) => `${c.table} holds ${c.width}`);
  if (write.reason.pendingEarlier) {
    parts.push('an earlier write for the key is waiting');
  }
  return `key of ${write.consolidationKey.length} characters; ${parts.join(', ')}`;
}

/**
 * Queues writes in the caller's transaction (a rolled-back batch leaves no
 * entry behind) and logs each one. A write already queued under the same
 * dedupe key is replaced, under the key it has now, and made pending again,
 * keeping its place.
 */
export async function deferSubscriptionWrites(
  writes: readonly DeferredWrite[],
  sink: DeferredWriteSink,
  nowMs: number = Date.now()
): Promise<void> {
  for (const write of writes) {
    await sink.query(
      `INSERT INTO ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        (kind, consolidation_key, key_hash, key_length, dedupe_key, payload, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE consolidation_key = VALUES(consolidation_key),
          key_hash = VALUES(key_hash), key_length = VALUES(key_length),
          payload = VALUES(payload), reason = VALUES(reason),
          replayed_at = NULL, outcome = NULL`,
      [
        write.kind,
        write.consolidationKey,
        keyHash(write.consolidationKey),
        write.consolidationKey.length,
        sha256(`${write.kind}|${write.dedupe}`),
        JSON.stringify(write.payload),
        reasonText(write),
        nowMs
      ]
    );
    logger.errorWithCode(
      'SUBSCRIPTION_KEY_DEFERRED',
      `[SUBSCRIPTION WRITE DEFERRED] [${write.kind}] ${reasonText(write)}`
    );
  }
}

/** What a replay claims an entry as. */
export type ReplayOutcome = 'DONE' | 'SKIPPED';

/**
 * Marks a queued write replayed, in the transaction that makes the write,
 * so a write is applied and marked together or not at all. The row is
 * locked first, so two runs can't both claim it. False when the entry was
 * already claimed or is gone: the caller then makes no write.
 */
export async function claimDeferredWrite(
  sequence: number,
  outcome: ReplayOutcome,
  sink: DeferredWriteSink,
  nowMs: number = Date.now()
): Promise<boolean> {
  const rows = (await sink.query(
    `SELECT replayed_at FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
      WHERE sequence = ? FOR UPDATE`,
    [sequence]
  )) as Array<{ replayed_at: number | string | null }>;
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0].replayed_at !== null
  ) {
    return false;
  }
  await sink.query(
    `UPDATE ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        SET replayed_at = ?, outcome = ?
      WHERE sequence = ?`,
    [nowMs, outcome, sequence]
  );
  return true;
}

interface PendingDeferredWrite {
  readonly sequence: number;
  readonly kind: DeferredWriteKind;
  readonly consolidation_key: string;
  readonly key_hash: string;
  readonly payload: unknown;
}

/**
 * Makes one queued write and claims it with `claimDeferredWrite`, both in
 * one transaction. Returns what it did, or null when another run had
 * already claimed it.
 */
export type DeferredWriteReplayer = (
  write: PendingDeferredWrite
) => Promise<ReplayOutcome | null>;

export interface ReplaySummary {
  readonly done: number;
  readonly skipped: number;
  /** Replayed, but the write had to wait again (its key must still wait). */
  readonly requeued: number;
  /** Not replayed this run: the key is too long, or an earlier entry blocks it. */
  readonly waiting: number;
  readonly failed: number;
}

function parsePayload(payload: unknown): unknown {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

async function isPendingAgain(sequence: number): Promise<boolean> {
  const rows = await sqlExecutor.execute<{ replayed_at: number | null }>(
    `SELECT replayed_at FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE} WHERE sequence = :sequence`,
    { sequence }
  );
  return rows.length === 1 && rows[0].replayed_at === null;
}

/**
 * Replays queued writes in queue order, a page at a time through the whole
 * queue. Only keys that now fit every subscription table are read (the
 * length filter is in the query); the rest count as waiting. A key's writes
 * stay in order: once one of its entries can't be replayed here (its kind is
 * replayed by another loop, the replay failed, or the write had to wait
 * again), the key's later entries wait too. Other keys go on.
 */
export async function replayDeferredSubscriptionWrites(
  replayers: Partial<Record<DeferredWriteKind, DeferredWriteReplayer>>,
  params: { readonly pageSize?: number; readonly maxEntries?: number } = {}
): Promise<ReplaySummary> {
  const pageSize = params.pageSize ?? 100;
  const maxEntries = params.maxEntries ?? 1000;
  const maxLength = await subscriptionKeyWidths.minWidth(
    SUBSCRIPTION_WRITE_TABLES
  );
  const [tooLong] = await sqlExecutor.execute<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
      WHERE replayed_at IS NULL AND key_length > :maxLength`,
    { maxLength }
  );
  const summary = {
    done: 0,
    skipped: 0,
    requeued: 0,
    waiting: Number(tooLong?.count ?? 0),
    failed: 0
  };
  const blockedKeys = new Set<string>();
  let after = 0;
  let seen = 0;
  while (seen < maxEntries) {
    const page = await sqlExecutor.execute<PendingDeferredWrite>(
      `SELECT sequence, kind, consolidation_key, key_hash, payload
         FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        WHERE replayed_at IS NULL AND sequence > :after AND key_length <= :maxLength
        ORDER BY sequence ASC
        LIMIT :pageSize`,
      { after, maxLength, pageSize }
    );
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      seen++;
      after = Number(row.sequence);
      const write = { ...row, payload: parsePayload(row.payload) };
      const replayer = replayers[write.kind];
      if (blockedKeys.has(write.key_hash) || !replayer) {
        blockedKeys.add(write.key_hash);
        summary.waiting++;
        continue;
      }
      try {
        const outcome = await replayer(write);
        if (outcome === 'DONE' && (await isPendingAgain(write.sequence))) {
          blockedKeys.add(write.key_hash);
          summary.requeued++;
        } else if (outcome === 'DONE') {
          summary.done++;
        } else if (outcome === 'SKIPPED') {
          summary.skipped++;
        }
      } catch (error) {
        blockedKeys.add(write.key_hash);
        summary.failed++;
        logger.error(
          `[DEFERRED WRITE REPLAY FAILED] [${write.kind}] [${write.sequence}]`,
          error
        );
      }
    }
  }
  return summary;
}
