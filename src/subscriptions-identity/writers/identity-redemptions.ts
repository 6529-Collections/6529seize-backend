import {
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { fetchMaxTransactionByBlockNumber, getDataSource } from '@/db';
import { Transaction } from '@/entities/ITransaction';
import { sqlExecutor } from '@/sql-executor';
import { validateNonSubscriptionAirdrop } from '@/transactionsProcessingLoop/subscriptions';
import { EntityManager } from 'typeorm';
import { roundSubscriptionBalance } from '../engine/parity-money';
import { IdentityWriteMode } from '../identity/identity-switch';
import { REDEMPTION_CURSOR_ID } from '../opening/opening-load';
import { compareKeyed, saveReport } from './identity-reports';
import { identityOfLegacyKeys } from './legacy-key-identities';

export interface IdentityRedemptionRun {
  /** The airdrop transactions matched in this run. */
  readonly transactions: string[];
  readonly charged: number;
  readonly unmatched: number;
}

async function chargeToken(
  transaction: Transaction,
  em: EntityManager
): Promise<boolean> {
  const [row] = await em.query(
    `SELECT id, identity_key, consolidation_key FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
      WHERE contract = ? AND token_id = ? AND airdrop_address = ?
        AND redeemed_count < subscribed_count
      ORDER BY phase ASC, phase_position ASC, id ASC
      LIMIT 1 FOR UPDATE`,
    [transaction.contract, transaction.token_id, transaction.to_address]
  );
  if (!row) {
    return false;
  }
  const identityKey: string = row.identity_key;
  const [balanceRow] = await em.query(
    `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = ? FOR UPDATE`,
    [identityKey]
  );
  // As the legacy loop: no balance counts as 0, and the charge is taken even
  // when it makes the balance negative.
  const balanceAfter = roundSubscriptionBalance(
    Number(balanceRow?.balance ?? 0) - MEMES_MINT_PRICE
  );
  await em.query(
    `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
    [identityKey, balanceAfter]
  );
  const [existing] = await em.query(
    `SELECT id FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
      WHERE contract = ? AND token_id = ? AND address = ? AND \`transaction\` = ? AND identity_key = ?`,
    [
      transaction.contract,
      transaction.token_id,
      transaction.to_address,
      transaction.transaction,
      identityKey
    ]
  );
  if (existing) {
    await em.query(
      `UPDATE ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
        SET value = value + ?, count = count + 1, balance_after = ? WHERE id = ?`,
      [MEMES_MINT_PRICE, balanceAfter, existing.id]
    );
  } else {
    await em.query(
      `INSERT INTO ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
        (identity_key, consolidation_key, contract, token_id, address, \`transaction\`,
         transaction_date, value, balance_after, count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        identityKey,
        row.consolidation_key,
        transaction.contract,
        transaction.token_id,
        transaction.to_address,
        transaction.transaction,
        transaction.transaction_date
          ? new Date(transaction.transaction_date)
          : null,
        MEMES_MINT_PRICE,
        balanceAfter
      ]
    );
  }
  await em.query(
    `UPDATE ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} SET redeemed_count = redeemed_count + 1 WHERE id = ?`,
    [row.id]
  );
  return true;
}

/**
 * Matches the airdrop mints after the identity tables' cursor against their
 * final rows, by the legacy redemption rules (validateNonSubscriptionAirdrop,
 * then one charge per token to the row for the airdrop address in phase and
 * position order), in one transaction with the cursor. Returns null before
 * an opening is loaded (no cursor).
 */
export async function redeemIdentityAirdrops(): Promise<IdentityRedemptionRun | null> {
  const [cursor] = await sqlExecutor.execute<{ block: number }>(
    `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
    { id: REDEMPTION_CURSOR_ID }
  );
  if (!cursor) {
    return null;
  }
  const maxBlockTransaction = await fetchMaxTransactionByBlockNumber();
  if (!maxBlockTransaction) {
    return { transactions: [], charged: 0, unmatched: 0 };
  }
  const airdrops: Transaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE}
      WHERE block > :after AND block <= :through
        AND from_address = :nullAddress AND value = 0 AND token_count > 0
      ORDER BY block ASC`,
    {
      after: Number(cursor.block),
      through: Number(maxBlockTransaction.block),
      nullAddress: NULL_ADDRESS
    }
  );
  let charged = 0;
  let unmatched = 0;
  const transactions = new Set<string>();
  await getDataSource().transaction(async (em) => {
    for (const airdrop of airdrops) {
      const validation = await validateNonSubscriptionAirdrop(airdrop, em);
      if (validation.valid) {
        continue;
      }
      transactions.add(airdrop.transaction);
      for (let i = 0; i < airdrop.token_count; i++) {
        if (await chargeToken(airdrop, em)) {
          charged++;
        } else {
          unmatched++;
        }
      }
    }
    await em.query(
      `UPDATE ${SUBSCRIPTIONS_ID_CURSORS_TABLE} SET block = ?, updated_at = ? WHERE id = ?`,
      [Number(maxBlockTransaction.block), Date.now(), REDEMPTION_CURSOR_ID]
    );
  });
  return { transactions: Array.from(transactions), charged, unmatched };
}

/**
 * Compares the legacy and identity redemptions of the same airdrops: per
 * identity and transaction, the tokens charged and the balance after.
 */
export async function reportRedemptionComparison(
  mode: IdentityWriteMode,
  run: IdentityRedemptionRun
): Promise<void> {
  if (run.transactions.length === 0) {
    return;
  }
  const legacyRows = await sqlExecutor.execute<{
    consolidation_key: string;
    transaction: string;
    token_id: number;
    count: number;
    balance_after: number;
  }>(
    `SELECT consolidation_key, \`transaction\`, token_id, count, balance_after
       FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} WHERE \`transaction\` IN (:transactions)`,
    { transactions: run.transactions }
  );
  const identityRows = await sqlExecutor.execute<{
    identity_key: string;
    transaction: string;
    token_id: number;
    count: number;
    balance_after: number;
  }>(
    `SELECT identity_key, \`transaction\`, token_id, count, balance_after
       FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE} WHERE \`transaction\` IN (:transactions)`,
    { transactions: run.transactions }
  );
  const identities = await identityOfLegacyKeys(
    legacyRows.map((r) => r.consolidation_key)
  );
  const notes: string[] = [];
  const legacy = new Map<string, string>();
  for (const r of legacyRows) {
    const identity = identities.get(r.consolidation_key.toLowerCase());
    if (!identity) {
      notes.push(`legacy key spans identities: ${r.consolidation_key}`);
      continue;
    }
    legacy.set(
      `${identity}|${r.transaction}|${r.token_id}`,
      `x${r.count} balance after ${r.balance_after}`
    );
  }
  const identity = new Map(
    identityRows.map((r) => [
      `${r.identity_key}|${r.transaction}|${r.token_id}`,
      `x${r.count} balance after ${r.balance_after}`
    ])
  );
  const diffs = compareKeyed(legacy, identity);
  await saveReport({
    kind: 'REDEMPTIONS',
    mode,
    contract: null,
    tokenId: null,
    verdict: diffs.length === 0 && notes.length === 0 ? 'MATCH' : 'DIFF',
    legacyRows: legacyRows.length,
    identityRows: identityRows.length,
    diffs,
    notes
  });
}
