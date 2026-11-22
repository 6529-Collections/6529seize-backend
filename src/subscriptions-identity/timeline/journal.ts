import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
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
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { sqlExecutor } from '@/sql-executor';
import { OPENING_STATE_ID, switchReason } from '../identity/identity-switch';
import { AS_TEXT } from '../opening/legacy-tables';
import { canonicalJson, sha256Hex } from '../opening/opening-file';

/*
 * The identity tables' journal. Every write to them after a load (a
 * top-up, a fold, a build, a phase pull, a redemption run, a person's
 * choice, a list upload) appends one entry to the shared record log, lane
 * `subs`, in the same transaction as the write. So the log holds every
 * change, in the order the changes committed, and an entry exists exactly
 * when its write does.
 *
 * An entry carries the facts the write acted on (`inputs`: a top-up's
 * hash, block, wallet and the identity it was credited to; a fold's wallet
 * and identity) and after-images of what it wrote:
 *   - for each identity it touched, its balance, mode and choice rows;
 *   - each history row it wrote, whole (logs, redemptions, final rows, top-up
 *     rows, uploads, the redemption cursor), with its id;
 *   - for a fold, the history rows it moved from the wallet to the identity;
 *   - for a build, that the card's final rows were replaced.
 * A rebuild loads the opening and writes these after-images back in log
 * order, so it never reads a source as it is today: a top-up stays with the
 * identity it was credited to, and times, ids and log order come out as
 * they were.
 *
 * A build entry also carries a checkpoint: the hash of every identity
 * table, read with share locks in the build's transaction, so writes still
 * in flight are either in it or after it in the log. A rebuild compares its
 * own tables with each checkpoint and stops at the first difference; that
 * is how a write that was never journaled shows up.
 */

/** The record log lane of the subscriptions journal (and of the signed subscription records). */
export const JOURNAL_LANE = 'subs';

export type JournalKind =
  | 'top-up'
  | 'fold'
  | 'build'
  | 'phase'
  | 'redemption'
  | 'choice'
  | 'upload'
  | 'opening';

interface TableSpec {
  readonly table: string;
  readonly key: readonly string[];
  readonly columns: readonly string[];
  /** Datetime columns, read as text so they round-trip exactly. */
  readonly times: readonly string[];
}

export const JOURNAL_TABLES = {
  balances: {
    table: SUBSCRIPTIONS_ID_BALANCES_TABLE,
    key: ['identity_key'],
    columns: ['identity_key', 'balance'],
    times: ['created_at', 'updated_at']
  },
  mode: {
    table: SUBSCRIPTIONS_ID_MODE_TABLE,
    key: ['identity_key'],
    columns: ['identity_key', 'automatic', 'subscribe_all_editions'],
    times: ['created_at', 'updated_at']
  },
  choices: {
    table: SUBSCRIPTIONS_ID_NFTS_TABLE,
    key: ['id'],
    columns: [
      'id',
      'identity_key',
      'contract',
      'token_id',
      'subscribed_count',
      'subscribed',
      'automatic_subscription'
    ],
    times: ['created_at', 'updated_at']
  },
  final: {
    table: SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
    key: ['id'],
    columns: [
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
      'redeemed_count'
    ],
    times: ['created_at', 'updated_at']
  },
  logs: {
    table: SUBSCRIPTIONS_ID_LOGS_TABLE,
    key: ['id'],
    columns: [
      'id',
      'legacy_id',
      'queue_sequence',
      'identity_key',
      'consolidation_key',
      'log',
      'additional_info'
    ],
    times: ['created_at']
  },
  redeemed: {
    table: SUBSCRIPTIONS_ID_REDEEMED_TABLE,
    key: ['id'],
    columns: [
      'id',
      'identity_key',
      'consolidation_key',
      'contract',
      'token_id',
      'address',
      'transaction',
      'value',
      'balance_after',
      'count'
    ],
    times: ['created_at', 'transaction_date']
  },
  top_up: {
    table: SUBSCRIPTIONS_ID_TOP_UP_TABLE,
    key: ['hash'],
    columns: ['hash', 'block', 'from_wallet', 'amount', 'identity_key'],
    times: ['created_at', 'transaction_date']
  },
  upload: {
    table: SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
    key: ['contract', 'token_id'],
    columns: ['contract', 'token_id', 'date', 'upload_url'],
    times: ['created_at']
  },
  cursor: {
    table: SUBSCRIPTIONS_ID_CURSORS_TABLE,
    key: ['id'],
    columns: ['id', 'block', 'updated_at'],
    times: []
  }
} as const satisfies Record<string, TableSpec>;

export type JournalTable = keyof typeof JOURNAL_TABLES;
type Row = Record<string, unknown>;

export interface IdentityImage {
  readonly key: string;
  readonly balance: Row | null;
  readonly mode: Row | null;
  readonly choices: Row[];
}

export interface JournalBody {
  readonly t: 'journal';
  readonly v: 1;
  readonly kind: JournalKind;
  /** The sha256 of the opening loaded when the write was made. */
  readonly opening: string;
  readonly mode: 'shadow' | 'truth';
  readonly at_ms: number;
  readonly inputs: Row;
  readonly identities: IdentityImage[];
  readonly rows: Array<{ readonly table: JournalTable; readonly row: Row }>;
  readonly rekeys: Array<{ readonly from: string; readonly to: string }>;
  readonly clear_card: {
    readonly contract: string;
    readonly token_id: number;
  } | null;
  readonly state_sha256: string | null;
}

/** The tables of a write that the entry holds whole, by primary key. */
export type JournalRowSelection = ReadonlyArray<{
  readonly table: JournalTable;
  readonly keys: ReadonlyArray<Record<string, unknown>>;
}>;

export interface JournalWrite {
  readonly kind: JournalKind;
  readonly inputs: Row;
  readonly identities?: readonly string[];
  readonly rows?: JournalRowSelection;
  readonly rekeys?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
  }>;
  readonly clearCard?: { readonly contract: string; readonly tokenId: number };
  /** Hash every identity table, under share locks (the daily build). */
  readonly checkpoint?: boolean;
  readonly atMs?: number;
}

function selectList(spec: TableSpec): string {
  return [
    ...spec.columns.map((c) => `\`${c}\``),
    ...spec.times.map((t) => `${AS_TEXT(t)} AS \`${t}\``)
  ].join(', ');
}

function orderBy(spec: TableSpec): string {
  return spec.key.map((k) => `\`${k}\``).join(', ');
}

async function readWhere(
  table: JournalTable,
  where: string,
  params: Record<string, unknown>,
  options: DbQueryOptions,
  lock = ''
): Promise<Row[]> {
  const spec: TableSpec = JOURNAL_TABLES[table];
  return sqlExecutor.execute<Row>(
    `SELECT ${selectList(spec)} FROM ${spec.table} WHERE ${where} ORDER BY ${orderBy(spec)}${lock}`,
    params,
    options
  );
}

/** One identity's balance, mode and choice rows as they are now. */
export async function identityImage(
  key: string,
  options: DbQueryOptions
): Promise<IdentityImage> {
  const where = 'identity_key = :key';
  const [balance] = await readWhere('balances', where, { key }, options);
  const [mode] = await readWhere('mode', where, { key }, options);
  return {
    key,
    balance: balance ?? null,
    mode: mode ?? null,
    choices: await readWhere('choices', where, { key }, options)
  };
}

async function rowsByKeys(
  table: JournalTable,
  keys: ReadonlyArray<Record<string, unknown>>,
  options: DbQueryOptions
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const key of keys) {
    const where = Object.keys(key)
      .map((column) => `\`${column}\` = :${column}`)
      .join(' AND ');
    rows.push(...(await readWhere(table, where, key, options)));
  }
  return rows;
}

/**
 * The hash of every identity table. Each table is summed in the database
 * (its row count, and the XOR of the first 64 bits of each row's SHA-256
 * over every column as text), so a daily checkpoint never loads the tables
 * into memory; rows have unique keys, so none cancel out. With `lock` the
 * rows are read with share locks, so writes in flight finish first and later
 * writes wait: the hash sits exactly at its entry's place in the log.
 */
export async function identityTablesHash(
  options: DbQueryOptions,
  lock = false
): Promise<string> {
  const parts: Record<string, { rows: string; xor: string }> = {};
  for (const table of Object.keys(JOURNAL_TABLES) as JournalTable[]) {
    const spec: TableSpec = JOURNAL_TABLES[table];
    const fields = [
      ...spec.columns.map((c) => `IFNULL(CAST(\`${c}\` AS CHAR), '\\N')`),
      ...spec.times.map((t) => `IFNULL(${AS_TEXT(t)}, '\\N')`)
    ].join(', ');
    // The cursors table also holds go-live's marker, which is not state.
    const where = table === 'cursor' ? `WHERE id <> 'writes-closed'` : '';
    const [sum] = await sqlExecutor.execute<{
      row_count: number | string;
      row_xor: number | string | null;
    }>(
      // Both as text: the XOR is a 64-bit unsigned number, which the driver
      // would hand back as a BigInt.
      `SELECT CAST(COUNT(*) AS CHAR) AS row_count,
              LPAD(HEX(BIT_XOR(CAST(CONV(LEFT(SHA2(CONCAT_WS('|', ${fields}), 256), 16), 16, 10) AS UNSIGNED))), 16, '0') AS row_xor
         FROM ${spec.table} ${where}${lock ? ' LOCK IN SHARE MODE' : ''}`,
      {},
      options
    );
    parts[table] = {
      rows: String(sum.row_count),
      xor: String(sum.row_xor ?? 0)
    };
  }
  return sha256Hex(canonicalJson(parts));
}

/** The loaded opening, and whether its tables are the truth at `atMs`. */
async function openingNow(
  options: DbQueryOptions,
  atMs: number
): Promise<{ opening: string; mode: 'shadow' | 'truth' }> {
  const [state] = await sqlExecutor.execute<{
    opening_sha256: string;
    cut_at: number | string;
    verified_at: number | string | null;
    suspended_at: number | string | null;
    switch_at: number | string | null;
  }>(
    `SELECT opening_sha256, cut_at, verified_at, suspended_at, switch_at
       FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID },
    options
  );
  if (!state) {
    throw new Error(
      'No opening is loaded: there is nothing to journal against'
    );
  }
  if (state.suspended_at !== null) {
    // Suspended tables (a rollback, or a rebuild writing the journal back)
    // take no writes.
    throw new Error('The identity tables are suspended: no writer writes them');
  }
  const asNumber = (value: number | string | null) =>
    value === null ? null : Number(value);
  const reason = switchReason(
    {
      opening_sha256: state.opening_sha256,
      cut_at: Number(state.cut_at),
      verified_at: asNumber(state.verified_at),
      suspended_at: asNumber(state.suspended_at),
      switch_at: asNumber(state.switch_at)
    },
    atMs
  );
  return {
    opening: state.opening_sha256,
    mode: reason === 'IDENTITY_TABLES' ? 'truth' : 'shadow'
  };
}

/** Builds a write's entry from what its transaction can read now. */
export async function journalBody(
  write: JournalWrite,
  options: DbQueryOptions
): Promise<JournalBody> {
  const identities: IdentityImage[] = [];
  for (const key of Array.from(new Set(write.identities ?? []))) {
    identities.push(await identityImage(key, options));
  }
  const rows: JournalBody['rows'] = [];
  for (const selection of write.rows ?? []) {
    for (const row of await rowsByKeys(
      selection.table,
      selection.keys,
      options
    )) {
      rows.push({ table: selection.table, row });
    }
  }
  const atMs = write.atMs ?? Date.now();
  const { opening, mode } = await openingNow(options, atMs);
  return {
    t: 'journal',
    v: 1,
    kind: write.kind,
    opening,
    mode,
    at_ms: atMs,
    inputs: write.inputs,
    identities,
    rows,
    rekeys: [...(write.rekeys ?? [])],
    clear_card: write.clearCard
      ? {
          contract: write.clearCard.contract,
          token_id: write.clearCard.tokenId
        }
      : null,
    state_sha256: write.checkpoint
      ? await identityTablesHash(options, true)
      : null
  };
}

/**
 * The shared record log's writer over its own table. Journal entries are
 * service entries, so no grant proof is ever looked up.
 */
const sharedRecordLog = new RecordLogWriter(recordLogDb, {
  findGrantProofs: async () => {
    throw new Error('Journal entries carry no signed events');
  }
});

/**
 * Appends a write's journal entry in its own transaction (options must
 * carry the transaction's connection).
 */
export async function journal(
  write: JournalWrite,
  options: DbQueryOptions
): Promise<JournalBody> {
  if (!options.wrappedConnection) {
    throw new Error("A journal entry is written in its write's transaction");
  }
  const body = await journalBody(write, options);
  const entry: RecordLogEntry = {
    t: 'entry',
    lane: JOURNAL_LANE,
    chain: 'public',
    body: stripUndefined(body) as Record<string, unknown>
  };
  await sharedRecordLog.append([entry], {
    connection: options.wrappedConnection
  });
  return body;
}

function stripUndefined(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function insertRow(
  table: JournalTable,
  row: Row,
  options: DbQueryOptions
): Promise<unknown> {
  const spec: TableSpec = JOURNAL_TABLES[table];
  const columns = [...spec.columns, ...spec.times].filter(
    (c) => row[c] !== undefined
  );
  return sqlExecutor.execute(
    `REPLACE INTO ${spec.table} (${columns.map((c) => `\`${c}\``).join(', ')})
      VALUES (${columns.map((_, i) => `:c${i}`).join(', ')})`,
    Object.fromEntries(columns.map((c, i) => [`c${i}`, row[c]])),
    options
  );
}

/**
 * Writes an entry's after-images back (a rebuild), in the caller's
 * transaction: the card's final rows cleared, history moved by the
 * rekeys, each touched identity's rows replaced, each history row written
 * by its key.
 */
export async function applyJournalBody(
  body: JournalBody,
  options: DbQueryOptions
): Promise<void> {
  const run = (sql: string, params: Record<string, unknown>) =>
    sqlExecutor.execute(sql, params, options);
  if (body.clear_card) {
    await run(
      `DELETE FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE contract = :contract AND token_id = :tokenId`,
      { contract: body.clear_card.contract, tokenId: body.clear_card.token_id }
    );
  }
  for (const { from, to } of body.rekeys) {
    for (const table of [
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_ID_REDEEMED_TABLE,
      SUBSCRIPTIONS_ID_LOGS_TABLE,
      SUBSCRIPTIONS_ID_TOP_UP_TABLE
    ]) {
      const keepTime =
        table === SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE
          ? ', updated_at = updated_at'
          : '';
      await run(
        `UPDATE ${table} SET identity_key = :to${keepTime} WHERE identity_key = :from`,
        { from, to }
      );
    }
  }
  for (const image of body.identities) {
    for (const table of ['balances', 'mode', 'choices'] as const) {
      await run(
        `DELETE FROM ${JOURNAL_TABLES[table].table} WHERE identity_key = :key`,
        { key: image.key }
      );
    }
    if (image.balance) {
      await insertRow('balances', image.balance, options);
    }
    if (image.mode) {
      await insertRow('mode', image.mode, options);
    }
    for (const choice of image.choices) {
      await insertRow('choices', choice, options);
    }
  }
  for (const { table, row } of body.rows) {
    await insertRow(table, row, options);
  }
}

/** A journal entry's body, if the log entry is one. */
export function journalBodyOf(entry: RecordLogEntry): JournalBody | null {
  if (entry.t !== 'entry' || entry.lane !== JOURNAL_LANE) {
    return null;
  }
  const body = entry.body as Partial<JournalBody>;
  return body.t === 'journal' && body.v === 1 ? (body as JournalBody) : null;
}

/** Inserts a log line and returns its id (the journal keeps log ids). */
export async function insertIdentityLog(
  line: {
    readonly identityKey: string;
    readonly consolidationKey: string;
    readonly log: string;
    readonly additionalInfo: string | null;
    readonly atText: string;
  },
  options: DbQueryOptions
): Promise<number> {
  if (!options.wrappedConnection) {
    throw new Error("A log line's id is read on its own connection");
  }
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_ID_LOGS_TABLE}
      (identity_key, consolidation_key, log, additional_info, created_at)
      VALUES (:identityKey, :consolidationKey, :log, :additionalInfo, :atText)`,
    line,
    options
  );
  const [row] = await sqlExecutor.execute<{ id: number | string }>(
    `SELECT LAST_INSERT_ID() AS id`,
    {},
    options
  );
  return Number(row.id);
}
