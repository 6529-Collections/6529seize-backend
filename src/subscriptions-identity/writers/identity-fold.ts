import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { mergeUpcomingSubscriptions } from '@/subscriptionsDaily/subscription-merge';
import {
  IdentityDirectory,
  isPrincipalId,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import { AS_TEXT, flag } from '../opening/legacy-tables';

/*
 * A wallet that binds to an identity after the opening brings its state
 * with it (owner question O2; this file is the one place the rule lives):
 * its balance is added to the identity's, automatic and all editions are
 * kept if either had them, choices for the same card are combined as the
 * legacy merge does (mergeUpcomingSubscriptions), and its history rows move
 * to the identity. A wallet that leaves takes nothing.
 */

type ChoiceRow = {
  id: number;
  token_id: number;
  contract: string;
  subscribed: number;
  automatic_subscription: number;
  subscribed_count: number;
  updated_at: string;
};

/** Folds the wallet-keyed state of wallets now bound to an identity. */
export async function foldBoundWallets(
  directory: IdentityDirectory = mirrorIdentityDirectory
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
      const q = <T>(sql: string, p: Record<string, unknown>) =>
        sqlExecutor.execute<T>(sql, p, options);
      const [walletBalance] = await q<{ balance: number }>(
        `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :wallet FOR UPDATE`,
        { wallet }
      );
      if (walletBalance) {
        await q(
          `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance)
            VALUES (:identity, :balance)
            ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
          { identity, balance: Number(walletBalance.balance) }
        );
      }
      const [walletMode] = await q<{
        automatic: number;
        subscribe_all_editions: number;
      }>(
        `SELECT automatic, subscribe_all_editions FROM ${SUBSCRIPTIONS_ID_MODE_TABLE}
          WHERE identity_key = :wallet FOR UPDATE`,
        { wallet }
      );
      if (walletMode) {
        await q(
          `INSERT INTO ${SUBSCRIPTIONS_ID_MODE_TABLE} (identity_key, automatic, subscribe_all_editions)
            VALUES (:identity, :automatic, :all)
            ON DUPLICATE KEY UPDATE automatic = automatic OR VALUES(automatic),
              subscribe_all_editions = subscribe_all_editions OR VALUES(subscribe_all_editions)`,
          {
            identity,
            automatic: flag(walletMode.automatic),
            all: flag(walletMode.subscribe_all_editions)
          }
        );
      }
      const choices = (wallet: string) =>
        q<ChoiceRow>(
          `SELECT id, contract, token_id, subscribed, automatic_subscription, subscribed_count,
                  ${AS_TEXT('updated_at')} AS updated_at
             FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE identity_key = :key FOR UPDATE`,
          { key: wallet }
        );
      const surviving = new Map(
        (await choices(identity)).map((c) => [
          `${c.contract}|${Number(c.token_id)}`,
          c
        ])
      );
      for (const moved of await choices(wallet)) {
        const card = `${moved.contract}|${Number(moved.token_id)}`;
        const kept = surviving.get(card);
        if (!kept) {
          await q(
            `UPDATE ${SUBSCRIPTIONS_ID_NFTS_TABLE} SET identity_key = :identity, updated_at = updated_at WHERE id = :id`,
            { identity, id: moved.id }
          );
          continue;
        }
        const state = (c: ChoiceRow) => ({
          subscribed: flag(c.subscribed),
          automatic_subscription: flag(c.automatic_subscription),
          subscribed_count: Number(c.subscribed_count),
          updated_at: new Date(
            `${c.updated_at.replace(' ', 'T').slice(0, 23)}Z`
          )
        });
        const keptState = state(kept);
        const combined = mergeUpcomingSubscriptions(keptState, state(moved));
        if (combined !== keptState) {
          const earliest = [kept, moved]
            .filter((c) => flag(c.subscribed))
            .map((c) => c.updated_at)
            .sort()[0];
          await q(
            `UPDATE ${SUBSCRIPTIONS_ID_NFTS_TABLE}
              SET subscribed = :subscribed, automatic_subscription = :automatic,
                subscribed_count = :count, updated_at = :updatedAt
              WHERE id = :id`,
            {
              subscribed: combined.subscribed,
              automatic: combined.automatic_subscription,
              count: combined.subscribed_count,
              updatedAt: earliest,
              id: kept.id
            }
          );
        }
        await q(`DELETE FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE id = :id`, {
          id: moved.id
        });
      }
      await q(
        `DELETE FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :wallet`,
        { wallet }
      );
      await q(
        `DELETE FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} WHERE identity_key = :wallet`,
        { wallet }
      );
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
        await q(
          `UPDATE ${table} SET identity_key = :identity${keepTime} WHERE identity_key = :wallet`,
          { identity, wallet }
        );
      }
    });
    folded++;
  }
  return folded;
}
