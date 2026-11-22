import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import {
  IdentityDirectory,
  isPrincipalId,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import { MergeState, mergeStates } from '../identity/identity-merge';
import { AS_TEXT, flag, msToDbText } from '../opening/legacy-tables';

/*
 * A wallet that binds to an identity after the opening brings its state
 * with it, by the one merge rule (identity-merge.ts): the identity's state
 * survives and the wallet's is folded in at the time of the fold, and the
 * wallet's history rows move to the identity. A wallet that leaves takes
 * nothing.
 */

async function readState(
  identityKey: string,
  options: DbQueryOptions
): Promise<MergeState> {
  const q = <T>(sql: string) =>
    sqlExecutor.execute<T>(sql, { identityKey }, options);
  const [balance] = await q<{
    balance: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT balance, ${AS_TEXT('created_at')} AS created_at, ${AS_TEXT('updated_at')} AS updated_at
       FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :identityKey FOR UPDATE`
  );
  const [mode] = await q<{
    automatic: number;
    subscribe_all_editions: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT automatic, subscribe_all_editions, ${AS_TEXT('created_at')} AS created_at,
            ${AS_TEXT('updated_at')} AS updated_at
       FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} WHERE identity_key = :identityKey FOR UPDATE`
  );
  const choices = await q<{
    contract: string;
    token_id: number;
    subscribed: number;
    subscribed_count: number;
    automatic_subscription: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT contract, token_id, subscribed, subscribed_count, automatic_subscription,
            ${AS_TEXT('created_at')} AS created_at, ${AS_TEXT('updated_at')} AS updated_at
       FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE identity_key = :identityKey ORDER BY id FOR UPDATE`
  );
  return {
    balance: balance
      ? {
          balance: Number(balance.balance),
          createdAt: balance.created_at,
          updatedAt: balance.updated_at
        }
      : null,
    mode: mode
      ? {
          automatic: flag(mode.automatic),
          subscribeAllEditions: flag(mode.subscribe_all_editions),
          createdAt: mode.created_at,
          updatedAt: mode.updated_at
        }
      : null,
    choices: choices.map((c) => ({
      contract: c.contract,
      tokenId: Number(c.token_id),
      subscribed: flag(c.subscribed),
      subscribedCount: Number(c.subscribed_count),
      automaticSubscription: flag(c.automatic_subscription),
      createdAt: c.created_at,
      updatedAt: c.updated_at
    }))
  };
}

async function writeState(
  identityKey: string,
  state: MergeState,
  options: DbQueryOptions
): Promise<void> {
  const q = (sql: string, p: Record<string, unknown>) =>
    sqlExecutor.execute(sql, p, options);
  if (state.balance) {
    await q(
      `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance, created_at, updated_at)
        VALUES (:identityKey, :balance, :createdAt, :updatedAt)`,
      { identityKey, ...state.balance }
    );
  }
  if (state.mode) {
    await q(
      `INSERT INTO ${SUBSCRIPTIONS_ID_MODE_TABLE}
        (identity_key, automatic, subscribe_all_editions, created_at, updated_at)
        VALUES (:identityKey, :automatic, :all, :createdAt, :updatedAt)`,
      {
        identityKey,
        automatic: state.mode.automatic,
        all: state.mode.subscribeAllEditions,
        createdAt: state.mode.createdAt,
        updatedAt: state.mode.updatedAt
      }
    );
  }
  for (const choice of state.choices) {
    await q(
      `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_TABLE}
        (identity_key, contract, token_id, subscribed, subscribed_count, automatic_subscription,
         created_at, updated_at)
        VALUES (:identityKey, :contract, :tokenId, :subscribed, :count, :automatic,
         :createdAt, :updatedAt)`,
      {
        identityKey,
        contract: choice.contract,
        tokenId: choice.tokenId,
        subscribed: choice.subscribed,
        count: choice.subscribedCount,
        automatic: choice.automaticSubscription,
        createdAt: choice.createdAt,
        updatedAt: choice.updatedAt
      }
    );
  }
}

/** Folds the wallet-keyed state of wallets now bound to an identity. */
export async function foldBoundWallets(
  directory: IdentityDirectory = mirrorIdentityDirectory,
  nowMs: () => number = () => Date.now()
): Promise<number> {
  const keyed = await sqlExecutor.execute<{ identity_key: string }>(
    `SELECT identity_key FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE LENGTH(identity_key) = 42
     UNION SELECT identity_key FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} WHERE LENGTH(identity_key) = 42
     UNION SELECT identity_key FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE LENGTH(identity_key) = 42`
  );
  if (keyed.length === 0) {
    return 0;
  }
  const identities = await directory.identitiesOf(
    keyed.map((r) => r.identity_key)
  );
  let folded = 0;
  for (const [wallet, identity] of Array.from(identities.entries())) {
    if (identity === wallet || !isPrincipalId(identity)) {
      continue;
    }
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      const merged = mergeStates(
        [await readState(identity, options), await readState(wallet, options)],
        msToDbText(nowMs())
      );
      for (const table of [
        SUBSCRIPTIONS_ID_BALANCES_TABLE,
        SUBSCRIPTIONS_ID_MODE_TABLE,
        SUBSCRIPTIONS_ID_NFTS_TABLE
      ]) {
        await sqlExecutor.execute(
          `DELETE FROM ${table} WHERE identity_key IN (:keys)`,
          { keys: [identity, wallet] },
          options
        );
      }
      await writeState(identity, merged, options);
      for (const table of [
        SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
        SUBSCRIPTIONS_ID_REDEEMED_TABLE,
        SUBSCRIPTIONS_ID_LOGS_TABLE,
        SUBSCRIPTIONS_ID_TOP_UP_TABLE
      ]) {
        // Final rows keep their priority time (updated_at) when re-keyed.
        const keepTime =
          table === SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE
            ? ', updated_at = updated_at'
            : '';
        await sqlExecutor.execute(
          `UPDATE ${table} SET identity_key = :identity${keepTime} WHERE identity_key = :wallet`,
          { identity, wallet },
          options
        );
      }
    });
    folded++;
  }
  return folded;
}
