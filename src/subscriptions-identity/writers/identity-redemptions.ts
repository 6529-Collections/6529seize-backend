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
import { Transaction } from '@/entities/ITransaction';
import { sqlExecutor } from '@/sql-executor';
import {
  buildTransactionLinkFor,
  sendSubscriptionWaveNotifications,
  SubscriptionWaveNotification,
  validateNonSubscriptionAirdrop
} from '@/transactionsProcessingLoop/subscriptions';
import { EntityManager } from 'typeorm';
import { DbQueryOptions } from '@/db-query.options';
import { journal, JournalBefore, journalBefore } from '../timeline/journal';
import { msToDbText } from '../opening/legacy-tables';
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

/** One token of one airdrop, charged to one identity (the journal's input). */
interface Charge {
  readonly transaction: string;
  readonly contract: string;
  readonly token_id: number;
  readonly to_address: string;
  readonly token_count: number;
  readonly identity_key: string;
}

interface ChargeTouches {
  /** The rows this run changes, captured before it changes each. */
  readonly before: JournalBefore;
  readonly insertedRedeemedIds: number[];
  readonly charges: Charge[];
}

async function chargeToken(
  transaction: Transaction,
  options: DbQueryOptions,
  notices: SubscriptionWaveNotification[],
  touches: ChargeTouches
): Promise<boolean> {
  const q = <T>(sql: string, params: Record<string, unknown>) =>
    sqlExecutor.execute<T>(sql, params, options);
  const [row] = await q<{
    id: number;
    identity_key: string;
    consolidation_key: string;
  }>(
    `SELECT id, identity_key, consolidation_key FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
      WHERE contract = :contract AND token_id = :tokenId AND airdrop_address = :address
        AND redeemed_count < subscribed_count
      ORDER BY phase ASC, phase_position ASC, id ASC
      LIMIT 1 FOR UPDATE`,
    {
      contract: transaction.contract,
      tokenId: transaction.token_id,
      address: transaction.to_address
    }
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
  await touches.before.capture(
    {
      rows: [
        { table: 'balances', keys: [{ identity_key: identityKey }] },
        { table: 'final', keys: [{ id: Number(row.id) }] }
      ]
    },
    options
  );
  const [balanceRow] = await q<{ balance: number }>(
    `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :identityKey FOR UPDATE`,
    { identityKey }
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
  await q(
    `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance) VALUES (:identityKey, :balanceAfter)
      ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
    { identityKey, balanceAfter }
  );
  const redeemedKey = {
    contract: transaction.contract,
    tokenId: transaction.token_id,
    address: transaction.to_address,
    transaction: transaction.transaction,
    identityKey
  };
  const [existing] = await q<{ id: number }>(
    `SELECT id FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
      WHERE contract = :contract AND token_id = :tokenId AND address = :address
        AND \`transaction\` = :transaction AND identity_key = :identityKey`,
    redeemedKey
  );
  if (existing) {
    await touches.before.capture(
      { rows: [{ table: 'redeemed', keys: [{ id: Number(existing.id) }] }] },
      options
    );
    await q(
      `UPDATE ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
        SET value = value + :price, count = count + 1, balance_after = :balanceAfter WHERE id = :id`,
      { price: MEMES_MINT_PRICE, balanceAfter, id: existing.id }
    );
  } else {
    await q(
      `INSERT INTO ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
        (identity_key, consolidation_key, contract, token_id, address, \`transaction\`,
         transaction_date, value, balance_after, count)
        VALUES (:identityKey, :consolidationKey, :contract, :tokenId, :address, :transaction,
         :transactionDate, :price, :balanceAfter, 1)`,
      {
        ...redeemedKey,
        consolidationKey: row.consolidation_key,
        transactionDate: transaction.transaction_date
          ? msToDbText(new Date(transaction.transaction_date).getTime())
          : null,
        price: MEMES_MINT_PRICE,
        balanceAfter
      }
    );
    const [inserted] = await q<{ id: number | string }>(
      `SELECT LAST_INSERT_ID() AS id`,
      {}
    );
    touches.insertedRedeemedIds.push(Number(inserted.id));
  }
  await q(
    `UPDATE ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} SET redeemed_count = redeemed_count + 1 WHERE id = :id`,
    { id: row.id }
  );
  touches.charges.push({
    transaction: transaction.transaction,
    contract: transaction.contract,
    token_id: Number(transaction.token_id),
    to_address: transaction.to_address.toLowerCase(),
    token_count: Number(transaction.token_count),
    identity_key: identityKey
  });
  return true;
}

/** A run charges at most this many airdrops (whole blocks), so its journal stays small. */
export const REDEMPTION_RUN_MAX_AIRDROPS = 200;
/** ... and at most this many tokens. */
export const REDEMPTION_RUN_MAX_TOKENS = 1000;

/**
 * The airdrops a run takes: whole blocks, in order, while the run stays
 * within REDEMPTION_RUN_MAX_AIRDROPS airdrops and REDEMPTION_RUN_MAX_TOKENS
 * tokens, and the block the cursor moves to; the next run goes on from
 * there. A first block larger than either is taken whole: its journal
 * entry spreads the charges over as many parts as it needs, so any block
 * fits, and the caps keep every other run, and the time a run holds the
 * journal's counter, small.
 */
function boundedBatch(
  airdrops: Transaction[],
  through: number
): { airdrops: Transaction[]; through: number } {
  let airdropCount = 0;
  let tokens = 0;
  let end = 0;
  while (end < airdrops.length) {
    const block = Number(airdrops[end].block);
    let blockEnd = end;
    let blockTokens = 0;
    while (
      blockEnd < airdrops.length &&
      Number(airdrops[blockEnd].block) === block
    ) {
      blockTokens += Number(airdrops[blockEnd].token_count);
      blockEnd++;
    }
    const fits =
      airdropCount + (blockEnd - end) <= REDEMPTION_RUN_MAX_AIRDROPS &&
      tokens + blockTokens <= REDEMPTION_RUN_MAX_TOKENS;
    if (!fits && end > 0) {
      break;
    }
    airdropCount += blockEnd - end;
    tokens += blockTokens;
    end = blockEnd;
    if (!fits) {
      break;
    }
  }
  if (end === airdrops.length) {
    return { airdrops, through };
  }
  return {
    airdrops: airdrops.slice(0, end),
    through: Number(airdrops[end - 1].block)
  };
}

/**
 * The legacy airdrop check (validateNonSubscriptionAirdrop) reads through
 * a TypeORM EntityManager's positional query; this runs those reads in the
 * redemption run's own transaction.
 */
function inTransactionReads(options: DbQueryOptions): EntityManager {
  const query = (sql: string, values: unknown[] = []) => {
    const params: Record<string, unknown> = {};
    let index = 0;
    const named = sql.replace(/\?/g, () => {
      const name = `p${index}`;
      params[name] = values[index++];
      return `:${name}`;
    });
    return sqlExecutor.execute(named, params, options);
  };
  return { query } as unknown as EntityManager;
}

/**
 * Matches the airdrop mints after the identity tables' cursor against their
 * final rows, by the legacy redemption rules (validateNonSubscriptionAirdrop,
 * then one charge per token to the row for the airdrop address in phase and
 * position order), in one transaction with the cursor and the run's journal
 * entry. It goes only as far as the legacy loop has processed, so both
 * sides match the same airdrops. Returns null before an opening is loaded
 * (no cursor).
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
  const batch = boundedBatch(airdrops, through);
  let charged = 0;
  let unmatched = 0;
  const notices: SubscriptionWaveNotification[] = [];
  const byCard = new Map<
    string,
    { contract: string; tokenId: number; transactions: Set<string> }
  >();
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const touches: ChargeTouches = {
      before: await journalBefore(
        { rows: [{ table: 'cursor', keys: [{ id: REDEMPTION_CURSOR_ID }] }] },
        options
      ),
      insertedRedeemedIds: [],
      charges: []
    };
    for (const airdrop of batch.airdrops) {
      const validation = await validateNonSubscriptionAirdrop(
        airdrop,
        inTransactionReads(options)
      );
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
        if (await chargeToken(airdrop, options, notices, touches)) {
          charged++;
        } else {
          unmatched++;
        }
      }
    }
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTIONS_ID_CURSORS_TABLE} SET block = :through, updated_at = :nowMs WHERE id = :id`,
      { through: batch.through, nowMs: Date.now(), id: REDEMPTION_CURSOR_ID },
      options
    );
    await journal(
      {
        kind: 'redemption',
        inputs: {
          after_block: Number(cursor.block),
          through_block: batch.through
        },
        // One charge per token: split across the entry's parts, so a large
        // airdrop block always fits.
        spread: { key: 'charges', items: touches.charges },
        before: touches.before,
        rows: [
          {
            table: 'redeemed',
            keys: touches.insertedRedeemedIds.map((id) => ({ id })),
            inserted: true
          }
        ]
      },
      options
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
