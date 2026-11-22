import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
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
import {
  OPENING_STATE_ID,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
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

/** The redemption writer's cursor row (subscriptions_id_cursors). */
export const REDEMPTION_CURSOR_ID = 'redemption';

export interface ParsedOpening {
  readonly opening: OpeningFile;
  readonly history: HistoryFile;
  readonly openingSha256: string;
  readonly historySha256: string;
}

/**
 * Each history log line's id, fixed by the file: the first line with a
 * legacy id keeps it. A line copied to more identities (a key that now
 * spans them) has the same legacy id on every copy, so each later copy, and
 * each line from the key-width queue, takes the next id above every legacy
 * one, in history order.
 */
export function logIds(
  logs: ReadonlyArray<{ readonly legacyId: number | null }>
): number[] {
  let next =
    logs.reduce((max, l) => Math.max(max, Number(l.legacyId ?? 0)), 0) + 1;
  const used = new Set<number>();
  return logs.map((l) => {
    const legacy = l.legacyId === null ? null : Number(l.legacyId);
    if (legacy !== null && !used.has(legacy)) {
      used.add(legacy);
      return legacy;
    }
    return next++;
  });
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
  if (opening.cut.redemptionBlock === null) {
    throw new Error(
      'The cut has no redemption block (the redemption loop never ran); the identity writer would charge every airdrop since block 0'
    );
  }
  // Never wipe identity tables that are, or are set to become, the truth.
  const [current] = await sqlExecutor.execute<{
    verified_at: number | null;
    suspended_at: number | null;
    switch_at: number | null;
  }>(
    `SELECT verified_at, suspended_at, switch_at FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID }
  );
  if (
    current &&
    current.switch_at !== null &&
    current.verified_at !== null &&
    current.suspended_at === null
  ) {
    throw new Error(
      'The identity tables are the truth (or set to become it); suspend them before loading again'
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
        'id',
        'identity_key',
        'contract',
        'token_id',
        'subscribed',
        'subscribed_count',
        'automatic_subscription',
        'created_at',
        'updated_at'
      ],
      // Every id the load gives is fixed by the files, so a rebuild's load
      // gives the same ids whatever the tables handed out before.
      opening.choices.map((c, index) => [
        index + 1,
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
        'id',
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
      opening.redeemed.map((r, index) => [
        index + 1,
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
        'id',
        'legacy_id',
        'queue_sequence',
        'identity_key',
        'consolidation_key',
        'log',
        'additional_info',
        'created_at'
      ],
      // A line keeps its legacy id, so the logs route shows the same ids
      // across the switch; a line from the key-width queue takes the next
      // id above every legacy one, in history order.
      logIds(history.logs).map((id, index) => {
        const l = history.logs[index];
        return [
          id,
          l.legacyId,
          l.queueSequence,
          l.identityKey,
          l.consolidationKey,
          l.log,
          l.additionalInfo,
          l.createdAt
        ];
      }),
      options
    );
    // The redemption writer goes on from the block the cut was at. Only
    // its own row is replaced: go-live's writes-closed marker is in this
    // table too, and it must stay until the switch.
    await sqlExecutor.execute(
      `DELETE FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
      { id: REDEMPTION_CURSOR_ID },
      options
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_CURSORS_TABLE} (id, block, updated_at)
        VALUES (:id, :block, :cutAt)`,
      {
        id: REDEMPTION_CURSOR_ID,
        block: opening.cut.redemptionBlock,
        cutAt: Date.parse(opening.cut.at)
      },
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
  subscriptionsIdentitySwitch.invalidate();
}
