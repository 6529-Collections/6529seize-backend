import {
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { hasMinimumBalanceForAutomaticMode } from '@/api/subscriptions/insufficient-subscription-balance.exception';
import { sqlExecutor } from '@/sql-executor';
import { roundSubscriptionBalance } from '../engine/parity-money';
import { compareText } from '../engine/text-order';
import {
  IdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import { AS_TEXT, msToDbText } from '../opening/legacy-tables';
import { turnIdentityAutomaticOn } from '../identity/identity-automatic';

interface PendingTopUp {
  readonly hash: string;
  readonly block: number;
  /** The database's datetime text. */
  readonly transactionDate: string;
  readonly fromWallet: string;
  readonly amount: number;
}

/**
 * Top-ups the identity tables have not credited: every legacy top-up row,
 * and every top-up the key-width guard still holds back, whose hash is not
 * in subscriptions_id_top_up. Ordered by block, then hash.
 */
async function pendingTopUps(): Promise<PendingTopUp[]> {
  const legacy = await sqlExecutor.execute<{
    hash: string;
    block: number;
    transaction_date: string;
    from_wallet: string;
    amount: number;
  }>(
    `SELECT t.hash, t.block, ${AS_TEXT('t.transaction_date')} AS transaction_date,
            t.from_wallet, t.amount
       FROM ${SUBSCRIPTIONS_TOP_UP_TABLE} t
       LEFT JOIN ${SUBSCRIPTIONS_ID_TOP_UP_TABLE} i ON i.hash = t.hash
      WHERE i.hash IS NULL`
  );
  const queued = await sqlExecutor.execute<{ payload: unknown }>(
    `SELECT q.payload FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE} q
      WHERE q.kind = 'TOP_UP' AND q.replayed_at IS NULL`
  );
  const credited = new Set(
    (
      await sqlExecutor.execute<{ hash: string }>(
        `SELECT hash FROM ${SUBSCRIPTIONS_ID_TOP_UP_TABLE}`
      )
    ).map((r) => r.hash.toLowerCase())
  );
  const byHash = new Map<string, PendingTopUp>();
  for (const r of legacy) {
    byHash.set(r.hash.toLowerCase(), {
      hash: r.hash,
      block: Number(r.block),
      transactionDate: r.transaction_date,
      fromWallet: r.from_wallet,
      amount: Number(r.amount)
    });
  }
  for (const row of queued) {
    const { topUp } = (
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    ) as {
      topUp: {
        hash: string;
        block: number;
        transaction_date: string;
        from_wallet: string;
        amount: number;
      };
    };
    const hash = topUp.hash.toLowerCase();
    if (!credited.has(hash) && !byHash.has(hash)) {
      byHash.set(hash, {
        hash: topUp.hash,
        block: Number(topUp.block),
        transactionDate: msToDbText(Date.parse(topUp.transaction_date)),
        fromWallet: topUp.from_wallet,
        amount: Number(topUp.amount)
      });
    }
  }
  return Array.from(byHash.values()).sort(
    (a, b) => a.block - b.block || compareText(a.hash, b.hash)
  );
}

/**
 * Credits new top-ups to the identity tables, each to the sender's identity
 * as the directory has it now, with the legacy top-up arithmetic: a first
 * top-up opens the balance unrounded and, if it covers a card, turns
 * automatic mode on as the legacy mode change does (turnIdentityAutomaticOn);
 * later ones add and round to five decimals. Times written are the
 * top-up's transaction time, so a rebuild writes the same. Each top-up
 * is one transaction, keyed by its hash, so a run that stops halfway goes
 * on where it stopped. Returns how many were credited.
 */
export async function creditIdentityTopUps(
  directory: IdentityDirectory = mirrorIdentityDirectory
): Promise<number> {
  const topUps = await pendingTopUps();
  if (topUps.length === 0) {
    return 0;
  }
  const identities = await directory.identitiesOf(
    topUps.map((t) => t.fromWallet)
  );
  const consolidationKeys = await directory.consolidationKeysOf(
    Array.from(new Set(identities.values()))
  );
  let credited = 0;
  for (const topUp of topUps) {
    const sender = topUp.fromWallet.toLowerCase();
    const identityKey = identities.get(sender) ?? sender;
    const done = await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        const options = { wrappedConnection: connection };
        const q = <T>(sql: string, params: Record<string, unknown>) =>
          sqlExecutor.execute<T>(sql, params, options);
        const already = await q<{ hash: string }>(
          `SELECT hash FROM ${SUBSCRIPTIONS_ID_TOP_UP_TABLE} WHERE hash = :hash FOR UPDATE`,
          { hash: topUp.hash }
        );
        if (already.length > 0) {
          return false;
        }
        const [balance] = await q<{ balance: number }>(
          `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE}
            WHERE identity_key = :identityKey FOR UPDATE`,
          { identityKey }
        );
        if (balance) {
          await q(
            `UPDATE ${SUBSCRIPTIONS_ID_BALANCES_TABLE} SET balance = :balance
              WHERE identity_key = :identityKey`,
            {
              identityKey,
              balance: roundSubscriptionBalance(
                Number(balance.balance) + topUp.amount
              )
            }
          );
        } else {
          await q(
            `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance, created_at, updated_at)
              VALUES (:identityKey, :balance, :at, :at)`,
            { identityKey, balance: topUp.amount, at: topUp.transactionDate }
          );
          if (hasMinimumBalanceForAutomaticMode(topUp.amount)) {
            await turnIdentityAutomaticOn({
              identityKey,
              consolidationKey: consolidationKeys.get(identityKey) ?? sender,
              atText: topUp.transactionDate,
              options
            });
          }
        }
        await q(
          `INSERT INTO ${SUBSCRIPTIONS_ID_TOP_UP_TABLE}
            (hash, block, transaction_date, from_wallet, amount, identity_key)
            VALUES (:hash, :block, :date, :from, :amount, :identityKey)`,
          {
            hash: topUp.hash,
            block: topUp.block,
            date: topUp.transactionDate,
            from: topUp.fromWallet,
            amount: topUp.amount,
            identityKey
          }
        );
        return true;
      }
    );
    if (done) {
      credited++;
    }
  }
  return credited;
}
