import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { SUBSCRIPTION_WRITE_TABLES } from '@/subscription-key-width/subscription-deferred-writes';
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
 * The key-width guard writes a key to the legacy tables only when every
 * subscription table can hold it (SUBSCRIPTION_WRITE_TABLES) and none of its
 * writes waits; otherwise the key's writes wait in the deferred writes queue
 * (src/subscription-key-width). The copy leaves out the keys the width rule
 * holds back, so no insert fails on a key column's width. It does not read
 * the queue: a key that fits but has an earlier write still waiting gets its
 * rows copied where production holds them until the replay. And a key wider
 * than that with legacy rows from before the guard keeps them in
 * production; the copy leaves them out.
 */

/** The widest key every subscription table can hold, read now. */
function widestKey(): Promise<number> {
  subscriptionKeyWidths.invalidate();
  return subscriptionKeyWidths.minWidth(SUBSCRIPTION_WRITE_TABLES);
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

const UPLOAD_COLUMNS = [
  'created_at',
  'contract',
  'token_id',
  'date',
  'upload_url'
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
 * The final rows, the lists' uploads and the redemptions: the identity rows
 * keep the consolidation key they were written under, a final row shares
 * its id with the legacy row, and after the switch both tables record the
 * one published list, so they copy back as they are. Rows of keys the guard
 * holds back are left out and counted.
 */
export async function copyLegacyHistory(): Promise<{
  readonly finals: number;
  readonly uploads: number;
  readonly redemptions: number;
  readonly leftOut: number;
}> {
  const width = await widestKey();
  const fits = `CHAR_LENGTH(consolidation_key) <= :width`;
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
      `INSERT INTO ${SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE} (${UPLOAD_COLUMNS.join(', ')})
        SELECT ${UPLOAD_COLUMNS.join(', ')} FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE}
         ORDER BY contract, token_id`,
      {},
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
      uploads: number | string;
      redemptions: number | string;
      left_out: number | string;
    }>(
      `SELECT (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}) AS finals,
              (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE}) AS uploads,
              (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}) AS redemptions,
              (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE NOT (${fits}))
              + (SELECT COUNT(*) FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE} WHERE NOT (${fits})) AS left_out`,
      { width },
      options
    );
    const leftOut = Number(counts.left_out);
    if (leftOut) {
      logger.warn(
        `[LEFT OUT ${leftOut} FINAL AND REDEEMED ROWS] the key-width guard holds their keys back (over ${width} characters)`
      );
    }
    return {
      finals: Number(counts.finals),
      uploads: Number(counts.uploads),
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
  const width = await widestKey();
  const written = { balances: 0, modes: 0, choices: 0 };
  let leftOut = 0;
  /** The row's legacy key, or null when the guard holds the key back. */
  const legacyKey = (identityKey: string): string | null => {
    const key = keyOf(identityKey);
    if (key.length > width) {
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
        `[LEFT OUT ${leftOut} BALANCE, MODE AND CHOICE ROWS] the key-width guard holds their keys back (over ${width} characters)`
      );
    }
    return { ...written, leftOut };
  });
}
