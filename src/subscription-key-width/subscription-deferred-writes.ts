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
const SUBSCRIPTION_WRITE_TABLES = [
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

async function hasPendingWrite(
  key: string,
  sink: DeferredWriteSink,
  beforeSequence?: number
): Promise<boolean> {
  const rows = (await sink.query(
    `SELECT sequence FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
      WHERE key_hash = ? AND replayed_at IS NULL${
        beforeSequence === undefined ? '' : ' AND sequence < ?'
      }
      LIMIT 1`,
    beforeSequence === undefined
      ? [keyHash(key)]
      : [keyHash(key), beforeSequence]
  )) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Why a write for `key` must wait, or null when it can be made now: the key
 * does not fit every subscription table, or the key has an earlier write
 * still waiting (one key's writes keep their order). A replayed entry passes
 * its own sequence so only writes queued before it count.
 */
export async function deferralReason(
  key: string,
  sink: DeferredWriteSink,
  beforeSequence?: number
): Promise<DeferralReason | null> {
  const narrow = await subscriptionKeyWidths.narrowFor(
    key,
    SUBSCRIPTION_WRITE_TABLES
  );
  const pendingEarlier = await hasPendingWrite(key, sink, beforeSequence);
  return narrow.length || pendingEarlier ? { narrow, pendingEarlier } : null;
}

/** The most wallets an identity can have and still fit every table. */
async function maxWalletsThatFit(): Promise<number> {
  let width = Number.POSITIVE_INFINITY;
  for (const table of SUBSCRIPTION_WRITE_TABLES) {
    width = Math.min(width, await subscriptionKeyWidths.widthOf(table));
  }
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
  return `Subscription changes for this identity resume ${resumeText()}, after its earlier updates are applied.`;
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
 * dedupe key is replaced and made pending again, keeping its place.
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
        ON DUPLICATE KEY UPDATE payload = VALUES(payload), reason = VALUES(reason),
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
  readonly waiting: number;
  readonly failed: number;
}

function parsePayload(payload: unknown): unknown {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

/**
 * Replays queued writes in queue order, a page at a time through the whole
 * queue. A key's writes stay in order: once one of its entries can't be
 * replayed here (the key still doesn't fit, its kind is replayed by another
 * loop, or the replay failed), the key's later entries wait too. Other keys
 * go on.
 */
export async function replayDeferredSubscriptionWrites(
  replayers: Partial<Record<DeferredWriteKind, DeferredWriteReplayer>>,
  params: { readonly pageSize?: number; readonly maxEntries?: number } = {}
): Promise<ReplaySummary> {
  const pageSize = params.pageSize ?? 100;
  const maxEntries = params.maxEntries ?? 1000;
  const summary = { done: 0, skipped: 0, waiting: 0, failed: 0 };
  const blockedKeys = new Set<string>();
  let after = 0;
  let seen = 0;
  while (seen < maxEntries) {
    const page = await sqlExecutor.execute<PendingDeferredWrite>(
      `SELECT sequence, kind, consolidation_key, key_hash, payload
         FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        WHERE replayed_at IS NULL AND sequence > :after
        ORDER BY sequence ASC
        LIMIT :pageSize`,
      { after, pageSize }
    );
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      seen++;
      after = Number(row.sequence);
      const write = { ...row, payload: parsePayload(row.payload) };
      const replayer = replayers[write.kind];
      if (
        blockedKeys.has(write.key_hash) ||
        !replayer ||
        (
          await subscriptionKeyWidths.narrowFor(
            write.consolidation_key,
            SUBSCRIPTION_WRITE_TABLES
          )
        ).length > 0
      ) {
        blockedKeys.add(write.key_hash);
        summary.waiting++;
        continue;
      }
      try {
        const outcome = await replayer(write);
        if (outcome === 'DONE') {
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
