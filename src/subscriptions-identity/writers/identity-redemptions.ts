import {
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { getDataSource } from '@/db';
import { Transaction } from '@/entities/ITransaction';
import { sqlExecutor } from '@/sql-executor';
import {
  buildTransactionLinkFor,
  sendSubscriptionWaveNotifications,
  SubscriptionWaveNotification,
  validateNonSubscriptionAirdrop
} from '@/transactionsProcessingLoop/subscriptions';
import { EntityManager } from 'typeorm';
import { roundSubscriptionBalance } from '../engine/parity-money';
import { IdentityWriteMode } from '../identity/identity-switch';
import { REDEMPTION_CURSOR_ID } from '../opening/opening-load';
import { compareKeyed, saveReport } from './identity-reports';
import { identityOfLegacyKeys } from './legacy-key-identities';

export interface IdentityRedemptionRun {
  /** The airdrop transactions matched in this run, by card. */
  readonly cards: ReadonlyArray<{
    readonly contract: string;
    readonly tokenId: number;
    readonly transactions: string[];
  }>;
  readonly charged: number;
  readonly unmatched: number;
  /** Warnings for the subscriptions wave, posted after the switch. */
  readonly notices: SubscriptionWaveNotification[];
}

async function chargeToken(
  transaction: Transaction,
  em: EntityManager,
  notices: SubscriptionWaveNotification[]
): Promise<boolean> {
  const [row] = await em.query(
    `SELECT id, identity_key, consolidation_key FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
      WHERE contract = ? AND token_id = ? AND airdrop_address = ?
        AND redeemed_count < subscribed_count
      ORDER BY phase ASC, phase_position ASC, id ASC
      LIMIT 1 FOR UPDATE`,
    [transaction.contract, transaction.token_id, transaction.to_address]
  );
  const transactionLink = buildTransactionLinkFor(transaction.transaction);
  if (!row) {
    notices.push({
      kind: 'no-subscription-found',
      airdropAddress: transaction.to_address,
      transactionLink
    });
    return false;
  }
  const identityKey: string = row.identity_key;
  const [balanceRow] = await em.query(
    `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = ? FOR UPDATE`,
    [identityKey]
  );
  if (!balanceRow) {
    notices.push({
      kind: 'no-balance-found',
      consolidationKey: row.consolidation_key,
      transactionLink
    });
  } else if (MEMES_MINT_PRICE > Number(balanceRow.balance)) {
    notices.push({
      kind: 'insufficient-balance',
      consolidationKey: row.consolidation_key,
      transactionLink
    });
  }
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
 * position order), in one transaction with the cursor. It goes only as far
 * as the legacy loop has processed, so both sides match the same airdrops.
 * Returns null before an opening is loaded (no cursor).
 */
export async function redeemIdentityAirdrops(): Promise<IdentityRedemptionRun | null> {
  const [cursor] = await sqlExecutor.execute<{ block: number }>(
    `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
    { id: REDEMPTION_CURSOR_ID }
  );
  if (!cursor) {
    return null;
  }
  const [legacy] = await sqlExecutor.execute<{ block: number | null }>(
    `SELECT MAX(block) AS block FROM ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE}`
  );
  const through = legacy?.block === null ? null : Number(legacy?.block);
  if (
    through === null ||
    Number.isNaN(through) ||
    through <= Number(cursor.block)
  ) {
    return { cards: [], charged: 0, unmatched: 0, notices: [] };
  }
  const airdrops: Transaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE}
      WHERE block > :after AND block <= :through
        AND from_address = :nullAddress AND value = 0 AND token_count > 0
      ORDER BY block ASC`,
    {
      after: Number(cursor.block),
      through,
      nullAddress: NULL_ADDRESS
    }
  );
  let charged = 0;
  let unmatched = 0;
  const notices: SubscriptionWaveNotification[] = [];
  const byCard = new Map<
    string,
    { contract: string; tokenId: number; transactions: Set<string> }
  >();
  await getDataSource().transaction(async (em) => {
    for (const airdrop of airdrops) {
      const validation = await validateNonSubscriptionAirdrop(airdrop, em);
      if (validation.valid) {
        continue;
      }
      const card = `${airdrop.contract.toLowerCase()}|${airdrop.token_id}`;
      const entry = byCard.get(card) ?? {
        contract: airdrop.contract,
        tokenId: Number(airdrop.token_id),
        transactions: new Set<string>()
      };
      entry.transactions.add(airdrop.transaction);
      byCard.set(card, entry);
      for (let i = 0; i < airdrop.token_count; i++) {
        if (await chargeToken(airdrop, em, notices)) {
          charged++;
        } else {
          unmatched++;
        }
      }
    }
    await em.query(
      `UPDATE ${SUBSCRIPTIONS_ID_CURSORS_TABLE} SET block = ?, updated_at = ? WHERE id = ?`,
      [through, Date.now(), REDEMPTION_CURSOR_ID]
    );
  });
  return {
    cards: Array.from(byCard.values()).map((c) => ({
      contract: c.contract,
      tokenId: c.tokenId,
      transactions: Array.from(c.transactions)
    })),
    charged,
    unmatched,
    notices
  };
}

/**
 * Compares, per card, the legacy and identity redemptions of the same
 * airdrops: the tokens charged per identity and transaction, and each
 * touched identity's balance afterwards. A balance is compared only for an
 * identity whose legacy charges went to one legacy key; any other is named
 * in the notes, which makes the report DIFF.
 */
export async function reportRedemptionComparison(
  mode: IdentityWriteMode,
  run: IdentityRedemptionRun
): Promise<void> {
  for (const card of run.cards) {
    await reportCard(mode, card);
  }
}

async function reportCard(
  mode: IdentityWriteMode,
  card: IdentityRedemptionRun['cards'][number]
): Promise<void> {
  const legacyRows = await sqlExecutor.execute<{
    consolidation_key: string;
    transaction: string;
    count: number;
  }>(
    `SELECT consolidation_key, \`transaction\`, count FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
      WHERE \`transaction\` IN (:transactions) AND contract = :contract AND token_id = :tokenId`,
    {
      transactions: card.transactions,
      contract: card.contract,
      tokenId: card.tokenId
    }
  );
  const identityRows = await sqlExecutor.execute<{
    identity_key: string;
    transaction: string;
    count: number;
  }>(
    `SELECT identity_key, \`transaction\`, count FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
      WHERE \`transaction\` IN (:transactions) AND contract = :contract AND token_id = :tokenId`,
    {
      transactions: card.transactions,
      contract: card.contract,
      tokenId: card.tokenId
    }
  );
  const identities = await identityOfLegacyKeys(
    legacyRows.map((r) => r.consolidation_key)
  );
  const notes: string[] = [];
  const legacyCounts = new Map<string, number>();
  const legacyKeysOf = new Map<string, Set<string>>();
  for (const r of legacyRows) {
    const identity = identities.get(r.consolidation_key.toLowerCase());
    if (!identity) {
      notes.push(`legacy key spans identities: ${r.consolidation_key}`);
      continue;
    }
    const key = `${identity}|${r.transaction}`;
    legacyCounts.set(key, (legacyCounts.get(key) ?? 0) + Number(r.count));
    legacyKeysOf.set(
      identity,
      new Set([
        ...Array.from(legacyKeysOf.get(identity) ?? []),
        r.consolidation_key
      ])
    );
  }
  const identityCounts = new Map<string, number>();
  for (const r of identityRows) {
    const key = `${r.identity_key}|${r.transaction}`;
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + Number(r.count));
  }
  const asText = (m: Map<string, number>) =>
    new Map(Array.from(m.entries()).map(([k, v]) => [k, `x${v}`]));
  const legacy = asText(legacyCounts);
  const identity = asText(identityCounts);

  // Each touched identity's balance afterwards.
  const touched = Array.from(
    new Set([
      ...identityRows.map((r) => r.identity_key),
      ...Array.from(legacyKeysOf.keys())
    ])
  );
  for (const identityKey of touched) {
    const keys = Array.from(legacyKeysOf.get(identityKey) ?? []);
    if (keys.length !== 1) {
      notes.push(
        `balance of ${identityKey} not comparable: its charges went to ${keys.length} legacy keys`
      );
      continue;
    }
    const [legacyBalance] = await sqlExecutor.execute<{ balance: number }>(
      `SELECT balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE} WHERE consolidation_key = :key`,
      { key: keys[0] }
    );
    const [identityBalance] = await sqlExecutor.execute<{ balance: number }>(
      `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :identityKey`,
      { identityKey }
    );
    legacy.set(
      `${identityKey}|balance`,
      String(Number(legacyBalance?.balance ?? 0))
    );
    identity.set(
      `${identityKey}|balance`,
      String(Number(identityBalance?.balance ?? 0))
    );
  }
  const diffs = compareKeyed(legacy, identity);
  await saveReport({
    kind: 'REDEMPTIONS',
    mode,
    contract: card.contract,
    tokenId: card.tokenId,
    verdict: diffs.length === 0 && notes.length === 0 ? 'MATCH' : 'DIFF',
    legacyRows: legacyRows.length,
    identityRows: identityRows.length,
    diffs,
    notes
  });
}
