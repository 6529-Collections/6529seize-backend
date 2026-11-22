import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import { OPENING_STATE_ID } from '../identity/identity-switch';
import {
  HISTORY_FORMAT,
  HistoryFile,
  OPENING_FORMAT,
  OpeningFile,
  parseCanonical,
  sha256Hex
} from './opening-file';

/** The identity tables the opening file fills, in load order. */
export const IDENTITY_DATA_TABLES = [
  SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE
] as const;

const BATCH_SIZE = 200;

export interface ParsedOpening {
  readonly opening: OpeningFile;
  readonly history: HistoryFile;
  readonly openingSha256: string;
  readonly historySha256: string;
}

/** Parses both files and checks that the opening file names this history. */
export function parseOpeningFiles(
  openingBytes: string,
  historyBytes: string
): ParsedOpening {
  const opening = parseCanonical<OpeningFile>(openingBytes, OPENING_FORMAT);
  const history = parseCanonical<HistoryFile>(historyBytes, HISTORY_FORMAT);
  const historySha256 = sha256Hex(historyBytes);
  if (opening.historySha256 !== historySha256) {
    throw new Error(
      `The opening file names history ${opening.historySha256}, this history is ${historySha256}`
    );
  }
  if (history.cutAt !== opening.cut.at) {
    throw new Error('The history file is from another cut');
  }
  return {
    opening,
    history,
    openingSha256: sha256Hex(openingBytes),
    historySha256
  };
}

async function insertRows(
  table: string,
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  options: DbQueryOptions
): Promise<void> {
  const columnList = columns.map((c) => `\`${c}\``).join(', ');
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const params: Record<string, unknown> = {};
    const tuples = batch.map((row, r) => {
      const names = row.map((value, c) => {
        const name = `r${r}c${c}`;
        params[name] = value;
        return `:${name}`;
      });
      return `(${names.join(', ')})`;
    });
    await sqlExecutor.execute(
      `INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(', ')}`,
      params,
      options
    );
  }
}

/**
 * Empties the identity tables and loads both files into them, in one
 * transaction, with the opening state row unverified: the tables are not
 * the truth until the opening comparison (opening-compare.ts) marks them.
 * Refuses a file that lists blocked keys.
 */
export async function loadOpeningFiles(
  parsed: ParsedOpening,
  nowMs: number = Date.now()
): Promise<void> {
  const { opening, history } = parsed;
  if (opening.blocked.length > 0) {
    throw new Error(
      `The opening file lists ${opening.blocked.length} blocked keys; re-key them and cut again`
    );
  }
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await sqlExecutor.execute(
      `DELETE FROM ${SUBSCRIPTIONS_ID_STATE_TABLE}`,
      undefined,
      options
    );
    for (const table of IDENTITY_DATA_TABLES) {
      await sqlExecutor.execute(`DELETE FROM ${table}`, undefined, options);
    }
    await insertRows(
      SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
      ['consolidation_key', 'identity_key', 'identities'],
      opening.keys.map((k) => [
        k.consolidationKey,
        k.identityKey,
        JSON.stringify(k.identities)
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_BALANCES_TABLE,
      ['identity_key', 'balance', 'created_at', 'updated_at'],
      opening.balances.map((b) => [
        b.identityKey,
        b.balance,
        b.createdAt,
        b.updatedAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_MODE_TABLE,
      [
        'identity_key',
        'automatic',
        'subscribe_all_editions',
        'created_at',
        'updated_at'
      ],
      opening.modes.map((m) => [
        m.identityKey,
        m.automatic,
        m.subscribeAllEditions,
        m.createdAt,
        m.updatedAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_NFTS_TABLE,
      [
        'identity_key',
        'contract',
        'token_id',
        'subscribed',
        'subscribed_count',
        'automatic_subscription',
        'created_at',
        'updated_at'
      ],
      opening.choices.map((c) => [
        c.identityKey,
        c.contract,
        c.tokenId,
        c.subscribed,
        c.subscribedCount,
        c.automaticSubscription,
        c.createdAt,
        c.updatedAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_TOP_UP_TABLE,
      [
        'hash',
        'block',
        'transaction_date',
        'from_wallet',
        'amount',
        'identity_key',
        'created_at'
      ],
      opening.topUps.map((t) => [
        t.hash,
        t.block,
        t.transactionDate,
        t.fromWallet,
        t.amount,
        t.identityKey,
        t.createdAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      [
        'id',
        'identity_key',
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
        'redeemed_count',
        'created_at',
        'updated_at'
      ],
      opening.finalRows.map((f) => [
        f.id,
        f.identityKey,
        f.consolidationKey,
        f.contract,
        f.tokenId,
        f.subscribedCount,
        f.airdropAddress,
        f.balance,
        f.subscribedAt,
        f.phase,
        f.phaseSubscriptions,
        f.phasePosition,
        f.redeemedCount,
        f.createdAt,
        f.updatedAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
      ['contract', 'token_id', 'date', 'upload_url', 'created_at'],
      opening.uploads.map((u) => [
        u.contract,
        u.tokenId,
        u.date,
        u.uploadUrl,
        u.createdAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_REDEEMED_TABLE,
      [
        'identity_key',
        'consolidation_key',
        'contract',
        'token_id',
        'address',
        'transaction',
        'transaction_date',
        'value',
        'balance_after',
        'count',
        'created_at'
      ],
      opening.redeemed.map((r) => [
        r.identityKey,
        r.consolidationKey,
        r.contract,
        r.tokenId,
        r.address,
        r.transaction,
        r.transactionDate,
        r.value,
        r.balanceAfter,
        r.count,
        r.createdAt
      ]),
      options
    );
    await insertRows(
      SUBSCRIPTIONS_ID_LOGS_TABLE,
      [
        'legacy_id',
        'queue_sequence',
        'identity_key',
        'consolidation_key',
        'log',
        'additional_info',
        'created_at'
      ],
      history.logs.map((l) => [
        l.legacyId,
        l.queueSequence,
        l.identityKey,
        l.consolidationKey,
        l.log,
        l.additionalInfo,
        l.createdAt
      ]),
      options
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_STATE_TABLE}
        (id, opening_sha256, history_sha256, cut_at, loaded_at, verified_at, suspended_at)
        VALUES (:id, :opening, :history, :cutAt, :loadedAt, NULL, NULL)`,
      {
        id: OPENING_STATE_ID,
        opening: parsed.openingSha256,
        history: parsed.historySha256,
        cutAt: Date.parse(opening.cut.at),
        loadedAt: nowMs
      },
      options
    );
  });
}
