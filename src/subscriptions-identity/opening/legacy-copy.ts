import { createHash } from 'node:crypto';
import {
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { subscriptionKeyWidths } from '@/subscription-key-width/subscription-key-width';
import {
  IdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';

const logger = Logger.get('SUBSCRIPTIONS_LEGACY_COPY');

/*
 * After the switch the legacy subscription tables are the rollback copy:
 * every write to the identity tables is written to them too, under the
 * identity's consolidation key. Routes that don't switch still read them
 * (distributions, minting claims, metrics, mint stats, the ETH price
 * recovery and the public coverage route), so they are rebuilt from the
 * identity tables the way the dual write fills them. The copy is exact only
 * where a legacy key and an identity are one to one: a legacy key the
 * opening merged into another identity, or one whose wallets now span
 * identities, has no row of its own here, and the rows' own times are the
 * identity side's.
 *
 * The key-width guard writes a key to the legacy tables only when they can
 * all hold it and none of its writes waits; otherwise the key's writes wait
 * in the deferred writes queue (src/subscription-key-width). The copy
 * leaves out the same keys: a key with a write waiting there (every key too
 * wide for a legacy table has one), or one wider than a table the copy
 * writes, so no insert fails on a key column's width.
 */

/** sha256 of each key with a write waiting in the deferred writes queue. */
const WAITING_KEY_HASHES = `SELECT key_hash FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE} WHERE replayed_at IS NULL`;

/** The widest key every one of these legacy tables can hold, read now. */
function widestKey(tables: readonly string[]): Promise<number> {
  subscriptionKeyWidths.invalidate();
  return subscriptionKeyWidths.minWidth(tables);
}

const FINAL_COLUMNS = [
  'created_at',
  'updated_at',
  'id',
  'consolidation_key',
  'contract',
  'token_id',
  'subscribed_count',
  'airdrop_address',
  'balance',
  'subscribed_at',
  'phase',
  'phase_subscriptions',
  'phase_position',
  'redeemed_count'
].map((c) => `\`${c}\``);

const REDEEMED_COLUMNS = [
  'created_at',
  'contract',
  'token_id',
  'address',
  'transaction',
  'transaction_date',
  'consolidation_key',
  'value',
  'balance_after',
  'count'
].map((c) => `\`${c}\``);

/**
 * The final rows and redemptions: the identity rows keep the consolidation
 * key they were written under, and a final row shares its id with the
 * legacy row, so they copy back as they are. Rows of keys the guard holds
 * back are left out and counted.
 */
export async function copyLegacyHistory(): Promise<{
  readonly finals: number;
  readonly redemptions: number;
  readonly leftOut: number;
}> {
  const width = await widestKey([
    SUBSCRIPTIONS_NFTS_FINAL_TABLE,
    SUBSCRIPTIONS_REDEEMED_TABLE
  ]);
  const fits = `CHAR_LENGTH(consolidation_key) <= :width
    AND SHA2(LOWER(consolidation_key), 256) NOT IN (${WAITING_KEY_HASHES})`;
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} (${FINAL_COLUMNS.join(', ')})
        SELECT ${FINAL_COLUMNS.join(', ')} FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
         WHERE ${fits} ORDER BY id`,
      { width },
      options
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_REDEEMED_TABLE} (${REDEEMED_COLUMNS.join(', ')})
        SELECT ${REDEEMED_COLUMNS.join(', ')} FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
         WHERE ${fits} ORDER BY id`,
      { width },
      options
    );
    const [counts] = await sqlExecutor.execute<{
      finals: number | string;
      redemptions: number | string;
      left_out: number | string;
    }>(
      `SELECT (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}) AS finals,
              (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}) AS redemptions,
              (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE NOT (${fits}))
              + (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE} WHERE NOT (${fits})) AS left_out`,
      { width },
      options
    );
    const leftOut = Number(counts.left_out);
    if (leftOut) {
      logger.warn(
        `[LEFT OUT ${leftOut} FINAL AND REDEEMED ROWS] the key-width guard holds their keys back (over ${width} characters, or with writes waiting)`
      );
    }
    return {
      finals: Number(counts.finals),
      redemptions: Number(counts.redemptions),
      leftOut
    };
  });
}

/**
 * Balances, modes and choices, under each identity's consolidation key as
 * the dual write uses it (IdentityDirectory.consolidationKeysOf). Two
 * identities that map to one key would make two legacy rows of one key:
 * that refuses, naming them. Rows of keys the guard holds back are left out
 * and counted.
 */
export async function copyLegacyState(
  directory: IdentityDirectory = mirrorIdentityDirectory
): Promise<{
  readonly balances: number;
  readonly modes: number;
  readonly choices: number;
  readonly leftOut: number;
}> {
  const keyed = await sqlExecutor.execute<{ identity_key: string }>(
    `SELECT identity_key FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE}
     UNION SELECT identity_key FROM ${SUBSCRIPTIONS_ID_MODE_TABLE}
     UNION SELECT identity_key FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE}`
  );
  const identities = keyed.map((row) => row.identity_key.toLowerCase());
  const keys = await directory.consolidationKeysOf(identities);
  const keyOf = (identity: string) =>
    keys.get(identity.toLowerCase()) ?? identity.toLowerCase();
  const byKey = new Map<string, string>();
  for (const identity of identities) {
    const key = keyOf(identity);
    const other = byKey.get(key);
    if (other !== undefined && other !== identity) {
      throw new Error(
        `Identities ${other} and ${identity} share the consolidation key ${key}: no one legacy row holds them`
      );
    }
    byKey.set(key, identity);
  }
  const width = await widestKey([
    SUBSCRIPTIONS_BALANCES_TABLE,
    SUBSCRIPTIONS_MODE_TABLE,
    SUBSCRIPTIONS_NFTS_TABLE
  ]);
  const waiting = new Set(
    (await sqlExecutor.execute<{ key_hash: string }>(WAITING_KEY_HASHES)).map(
      (row) => row.key_hash.toLowerCase()
    )
  );
  const written = { balances: 0, modes: 0, choices: 0 };
  let leftOut = 0;
  /** The row's legacy key, or null when the guard holds the key back. */
  const legacyKey = (identityKey: string): string | null => {
    const key = keyOf(identityKey);
    const hash = createHash('sha256').update(key.toLowerCase()).digest('hex');
    if (key.length > width || waiting.has(hash)) {
      leftOut++;
      return null;
    }
    return key;
  };
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const q = <T>(sql: string, params: Record<string, unknown> = {}) =>
      sqlExecutor.execute<T>(sql, params, options);
    const balances = await q<{
      identity_key: string;
      balance: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT identity_key, balance, CAST(created_at AS CHAR) AS created_at,
              CAST(updated_at AS CHAR) AS updated_at
         FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} ORDER BY identity_key`
    );
    for (const row of balances) {
      const key = legacyKey(row.identity_key);
      if (key === null) {
        continue;
      }
      written.balances++;
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance, created_at, updated_at)
          VALUES (:key, :balance, :createdAt, :updatedAt)`,
        {
          key,
          balance: row.balance,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      );
    }
    const modes = await q<{
      identity_key: string;
      automatic: number;
      subscribe_all_editions: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT identity_key, automatic, subscribe_all_editions,
              CAST(created_at AS CHAR) AS created_at, CAST(updated_at AS CHAR) AS updated_at
         FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} ORDER BY identity_key`
    );
    for (const row of modes) {
      const key = legacyKey(row.identity_key);
      if (key === null) {
        continue;
      }
      written.modes++;
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE}
          (consolidation_key, automatic, subscribe_all_editions, created_at, updated_at)
          VALUES (:key, :automatic, :all, :createdAt, :updatedAt)`,
        {
          key,
          automatic: row.automatic,
          all: row.subscribe_all_editions,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      );
    }
    const choices = await q<{
      identity_key: string;
      contract: string;
      token_id: number;
      subscribed_count: number;
      subscribed: number;
      automatic_subscription: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT identity_key, contract, token_id, subscribed_count, subscribed,
              automatic_subscription, CAST(created_at AS CHAR) AS created_at,
              CAST(updated_at AS CHAR) AS updated_at
         FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} ORDER BY id`
    );
    for (const row of choices) {
      const key = legacyKey(row.identity_key);
      if (key === null) {
        continue;
      }
      written.choices++;
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE}
          (consolidation_key, contract, token_id, subscribed_count, subscribed,
           automatic_subscription, created_at, updated_at)
          VALUES (:key, :contract, :tokenId, :count, :subscribed, :automatic,
           :createdAt, :updatedAt)`,
        {
          key,
          contract: row.contract,
          tokenId: row.token_id,
          count: row.subscribed_count,
          subscribed: row.subscribed,
          automatic: row.automatic_subscription,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      );
    }
    if (leftOut) {
      logger.warn(
        `[LEFT OUT ${leftOut} BALANCE, MODE AND CHOICE ROWS] the key-width guard holds their keys back (over ${width} characters, or with writes waiting)`
      );
    }
    return { ...written, leftOut };
  });
}
