import {
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
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
import { Logger } from '@/logging';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { sqlExecutor } from '@/sql-executor';
import { OPENING_STATE_ID, switchReason } from '../identity/identity-switch';
import { AS_TEXT } from '../opening/legacy-tables';
import { canonicalJson, sha256Hex } from '../opening/opening-file';

/*
 * The identity tables' journal, version 2. Every write to the identity
 * tables after a load
 * appends its changed rows, before and after, to the shared record log in
 * the same transaction as the write: lane `subs` once the tables are the
 * truth, `subs-shadow` before. So the log holds every change in commit
 * order, and an entry exists exactly when its write does.
 *
 * - Only rows the write changed are journaled: a change is the row's
 *   `before` (read FOR UPDATE before the write, where the writer captures
 *   it) and its `after` (read in the write's own transaction, after it).
 *   Entries stay small however long an identity's history grows; a large
 *   write is split into parts of at most 1 MB, all in its transaction.
 * - Every write takes the next `n` from a counter row as its last step, so
 *   `n` follows commit order. A daily checkpoint hashes one consistent
 *   snapshot at a known `n` without holding locks.
 * - A rebuild applies the changes in `n` order and checks each captured
 *   `before` against the row it has rebuilt, so a write that was never
 *   journaled, or a wrong one, stops it at the first row it touched.
 */

const logger = Logger.get('SUBSCRIPTIONS_JOURNAL');

/** The record log lanes of the journal: after the switch, and before it. */
export const JOURNAL_LANE = 'subs';
export const JOURNAL_SHADOW_LANE = 'subs-shadow';

/** The counter row (in subscriptions_id_cursors) that hands out `n`. */
export const JOURNAL_COUNTER_ID = 'journal';

/** Parts are at most this many bytes of canonical JSON (the log's limit is 4 MiB). */
export const JOURNAL_PART_MAX_BYTES = 1_000_000;

export type JournalKind =
  | 'top-up'
  | 'fold'
  | 'build'
  | 'phase'
  | 'redemption'
  | 'choice'
  | 'upload'
  | 'opening'
  | 'checkpoint';

interface TableSpec {
  readonly table: string;
  /** The natural key a change is keyed by. */
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
    key: ['identity_key', 'contract', 'token_id'],
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

export interface JournalChange {
  readonly table: JournalTable;
  readonly key: Row;
  /** Absent: not captured. null: the row did not exist. */
  readonly before?: Row | null;
  /** null: the row was deleted. */
  readonly after: Row | null;
}

export interface JournalBody {
  readonly t: 'journal';
  readonly v: 2;
  readonly kind: JournalKind;
  readonly n: number;
  readonly part: number;
  readonly parts: number;
  /** The sha256 of the opening loaded when the write was made. */
  readonly opening: string;
  readonly mode: 'shadow' | 'truth';
  readonly at_ms: number;
  readonly inputs: Row;
  readonly changes: JournalChange[];
  readonly rekeys: Array<{ readonly from: string; readonly to: string }>;
  readonly checkpoint: {
    readonly through_n: number;
    readonly state_sha256: string;
  } | null;
}

/**
 * Rows a write touches: each element matches rows of one table by column
 * values (a primary or natural key, or a wider match such as all of an
 * identity's choice rows or a card's final rows). `inserted` says the rows
 * are new (before is null) without reading them first.
 */
export type JournalRowSelection = ReadonlyArray<{
  readonly table: JournalTable;
  readonly keys: ReadonlyArray<Record<string, unknown>>;
  readonly inserted?: boolean;
}>;

export interface JournalSelection {
  /** Shorthand: these identities' balance and mode rows. */
  readonly identities?: readonly string[];
  readonly rows?: JournalRowSelection;
}

export interface JournalWrite extends JournalSelection {
  readonly kind: JournalKind;
  readonly inputs: Row;
  /** The rows as they were before the write (journalBefore). */
  readonly before?: JournalBefore;
  readonly rekeys?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
  }>;
  readonly checkpoint?: {
    readonly through_n: number;
    readonly state_sha256: string;
  };
  readonly atMs?: number;
}

interface Match {
  readonly table: JournalTable;
  readonly match: Record<string, unknown>;
  readonly inserted: boolean;
}

function matchesOf(selection: JournalSelection): Match[] {
  const matches: Match[] = [];
  for (const key of selection.identities ?? []) {
    matches.push({
      table: 'balances',
      match: { identity_key: key },
      inserted: false
    });
    matches.push({
      table: 'mode',
      match: { identity_key: key },
      inserted: false
    });
  }
  for (const rows of selection.rows ?? []) {
    for (const key of rows.keys) {
      matches.push({
        table: rows.table,
        match: key,
        inserted: !!rows.inserted
      });
    }
  }
  return matches;
}

function matchId(m: Pick<Match, 'table' | 'match'>): string {
  return `${m.table}|${canonicalJson(m.match)}`;
}

function selectList(spec: TableSpec): string {
  return [
    ...spec.columns.map((c) => `\`${c}\``),
    ...spec.times.map((t) => `${AS_TEXT(t)} AS \`${t}\``)
  ].join(', ');
}

async function readMatch(
  m: Pick<Match, 'table' | 'match'>,
  options: DbQueryOptions,
  lock: '' | ' FOR UPDATE' | ' LOCK IN SHARE MODE'
): Promise<Row[]> {
  const spec: TableSpec = JOURNAL_TABLES[m.table];
  const columns = Object.keys(m.match);
  const where = columns.length
    ? columns.map((c, i) => `\`${c}\` = :m${i}`).join(' AND ')
    : '1 = 1';
  return sqlExecutor.execute<Row>(
    `SELECT ${selectList(spec)} FROM ${spec.table} WHERE ${where}
      ORDER BY ${spec.key.map((k) => `\`${k}\``).join(', ')}${lock}`,
    Object.fromEntries(columns.map((c, i) => [`m${i}`, m.match[c]])),
    options
  );
}

function keyOf(table: JournalTable, row: Row): Row {
  const spec: TableSpec = JOURNAL_TABLES[table];
  return Object.fromEntries(spec.key.map((k) => [k, row[k]]));
}

/** Rows as they were before a write, read FOR UPDATE; add to it as the write goes. */
export class JournalBefore {
  private readonly captured = new Map<string, Row[]>();

  /** Reads the selected rows FOR UPDATE, unless already captured. Call before writing them. */
  async capture(
    selection: JournalSelection,
    options: DbQueryOptions
  ): Promise<this> {
    for (const m of matchesOf(selection)) {
      const id = matchId(m);
      if (!this.captured.has(id)) {
        this.captured.set(
          id,
          m.inserted ? [] : await readMatch(m, options, ' FOR UPDATE')
        );
      }
    }
    return this;
  }

  rowsOf(m: Pick<Match, 'table' | 'match'>): Row[] | undefined {
    return this.captured.get(matchId(m));
  }

  matches(): Array<Pick<Match, 'table' | 'match'>> {
    return Array.from(this.captured.keys()).map((id) => {
      const bar = id.indexOf('|');
      return {
        table: id.slice(0, bar) as JournalTable,
        match: JSON.parse(id.slice(bar + 1)) as Record<string, unknown>
      };
    });
  }
}

/** Reads the selected rows FOR UPDATE before a write; pass it to journal(). */
export function journalBefore(
  selection: JournalSelection,
  options: DbQueryOptions
): Promise<JournalBefore> {
  return new JournalBefore().capture(selection, options);
}

/** Rows compare as text: the driver may give a number or a string. */
function sameRow(
  a: Row | null | undefined,
  b: Row | null | undefined
): boolean {
  return canonicalJson(asText(a ?? null)) === canonicalJson(asText(b ?? null));
}

function asText(row: Row | null): Row | null {
  return row === null
    ? null
    : Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          v === null || v === undefined ? null : String(v)
        ])
      );
}

/** The changes of a write: the selected rows before and after, where they differ. */
async function changesOf(
  write: JournalWrite,
  options: DbQueryOptions
): Promise<JournalChange[]> {
  const matches = matchesOf(write);
  for (const m of write.before?.matches() ?? []) {
    if (!matches.some((x) => matchId(x) === matchId(m))) {
      matches.push({ ...m, inserted: false });
    }
  }
  const seen = new Set<string>();
  const changes: JournalChange[] = [];
  for (const m of matches) {
    const id = matchId(m);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const before = m.inserted ? [] : write.before?.rowsOf(m);
    // The write's own rows are locked; anything else is read as the latest
    // committed version and held, so the entry is never older than its place.
    const after = await readMatch(m, options, ' LOCK IN SHARE MODE');
    const byKey = new Map<string, { before?: Row | null; after: Row | null }>();
    for (const row of before ?? []) {
      byKey.set(canonicalJson(keyOf(m.table, row)), {
        before: row,
        after: null
      });
    }
    for (const row of after) {
      const k = canonicalJson(keyOf(m.table, row));
      const entry = byKey.get(k);
      byKey.set(k, {
        before: before === undefined ? undefined : (entry?.before ?? null),
        after: row
      });
    }
    for (const [k, change] of Array.from(byKey.entries())) {
      if (change.before !== undefined && sameRow(change.before, change.after)) {
        continue;
      }
      changes.push({
        table: m.table,
        key: JSON.parse(k) as Row,
        ...(change.before === undefined ? {} : { before: change.before }),
        after: change.after
      });
    }
  }
  return changes;
}

interface OpeningNow {
  readonly opening: string;
  readonly mode: 'shadow' | 'truth';
}

/** The loaded opening, and whether its tables are the truth at `atMs`. */
async function openingNow(
  options: DbQueryOptions,
  atMs: number
): Promise<OpeningNow> {
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

/**
 * The next `n`, taken as a write's last step: the counter row stays locked
 * until the write commits, so `n` follows commit order.
 */
async function nextN(options: DbQueryOptions): Promise<number> {
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_ID_CURSORS_TABLE} (id, block, updated_at)
      VALUES (:id, 1, :now)
      ON DUPLICATE KEY UPDATE block = block + 1, updated_at = VALUES(updated_at)`,
    { id: JOURNAL_COUNTER_ID, now: Date.now() },
    options
  );
  const [row] = await sqlExecutor.execute<{ block: number | string }>(
    `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
    { id: JOURNAL_COUNTER_ID },
    options
  );
  return Number(row.block);
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Splits a write's changes into bodies of at most JOURNAL_PART_MAX_BYTES. */
function partsOf(
  base: Omit<JournalBody, 'part' | 'parts' | 'changes' | 'rekeys'>,
  changes: readonly JournalChange[],
  rekeys: JournalBody['rekeys']
): JournalBody[] {
  const groups: JournalChange[][] = [[]];
  // The whole log entry counts: the body inside {t, lane, chain, body}, with
  // room for part numbers of any size.
  const envelope = Buffer.byteLength(
    canonicalJson({
      t: 'entry',
      lane: JOURNAL_SHADOW_LANE,
      chain: 'public',
      body: stripUndefined({
        ...base,
        part: Number.MAX_SAFE_INTEGER,
        parts: Number.MAX_SAFE_INTEGER,
        changes: [],
        rekeys
      })
    }),
    'utf8'
  );
  let size = envelope;
  for (const change of changes) {
    const bytes =
      Buffer.byteLength(canonicalJson(stripUndefined(change)), 'utf8') + 1;
    if (envelope + bytes > JOURNAL_PART_MAX_BYTES) {
      throw new Error(
        `A ${change.table} row of ${bytes} bytes does not fit a journal part`
      );
    }
    if (
      size + bytes > JOURNAL_PART_MAX_BYTES &&
      groups[groups.length - 1].length
    ) {
      groups.push([]);
      size = envelope;
    }
    groups[groups.length - 1].push(change);
    size += bytes;
  }
  return groups.map((group, part) => ({
    ...base,
    part,
    parts: groups.length,
    changes: group,
    rekeys: part === 0 ? rekeys : []
  }));
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
 * Appends a write's journal entries in its own transaction (options must
 * carry the transaction's connection), as the write's last step. Returns
 * the bodies appended.
 */
export async function journal(
  write: JournalWrite,
  options: DbQueryOptions
): Promise<JournalBody[]> {
  if (!options.wrappedConnection) {
    throw new Error("A journal entry is written in its write's transaction");
  }
  const atMs = write.atMs ?? Date.now();
  const { opening, mode } = await openingNow(options, atMs);
  const changes = await changesOf(write, options);
  const n = await nextN(options);
  const bodies = partsOf(
    {
      t: 'journal',
      v: 2,
      kind: write.kind,
      n,
      opening,
      mode,
      at_ms: atMs,
      inputs: write.inputs,
      checkpoint: write.checkpoint ?? null
    },
    changes,
    [...(write.rekeys ?? [])]
  );
  const lane = mode === 'truth' ? JOURNAL_LANE : JOURNAL_SHADOW_LANE;
  try {
    await sharedRecordLog.append(
      bodies.map(
        (body): RecordLogEntry => ({
          t: 'entry',
          lane,
          chain: 'public',
          body: stripUndefined(body) as unknown as Record<string, unknown>
        })
      ),
      { connection: options.wrappedConnection }
    );
  } catch (error) {
    logger.errorWithCode(
      'SUBSCRIPTIONS_JOURNAL_APPEND_FAILED',
      `[JOURNAL APPEND FAILED] ${write.kind} n=${n}: ${(error as Error).message}`
    );
    throw error;
  }
  return bodies;
}

/** A journal entry's body, if the log entry is one. */
export function journalBodyOf(entry: RecordLogEntry): JournalBody | null {
  if (
    entry.t !== 'entry' ||
    (entry.lane !== JOURNAL_LANE && entry.lane !== JOURNAL_SHADOW_LANE)
  ) {
    return null;
  }
  const body = entry.body as Partial<JournalBody>;
  return body.t === 'journal' && body.v === 2 ? (body as JournalBody) : null;
}

function writeRow(
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
 * Why a change's rows are not the row its key names, or null. A rebuild
 * checks the keyed row and writes the after row, so the key must be the
 * table's natural key and both rows must carry it.
 */
export function journalKeyMismatch(change: JournalChange): string | null {
  const spec = JOURNAL_TABLES[change.table] as TableSpec | undefined;
  if (!spec) {
    return `${String(change.table)} is not a journal table`;
  }
  const columns = Object.keys(change.key);
  if (
    columns.length !== spec.key.length ||
    spec.key.some((k) => !columns.includes(k))
  ) {
    return `keyed by ${columns.join(', ')}, not ${spec.key.join(', ')}`;
  }
  for (const [side, row] of [
    ['before', change.before],
    ['after', change.after]
  ] as const) {
    if (row && spec.key.some((k) => String(row[k]) !== String(change.key[k]))) {
      return `its ${side} row is another row`;
    }
  }
  return null;
}

/**
 * Writes a body back (a rebuild), in the caller's transaction: a fold's
 * rekeys, then each change. A change whose rows are not the row its key
 * names stops the rebuild before anything is written, and so does a
 * captured `before` that differs from the rebuilt row.
 */
export async function applyJournalBody(
  body: JournalBody,
  options: DbQueryOptions
): Promise<void> {
  for (const change of body.changes) {
    const mismatch = journalKeyMismatch(change);
    if (mismatch) {
      throw new Error(
        `Row ${change.table} ${canonicalJson(change.key)} of journal n=${body.n} (${body.kind}): ${mismatch}`
      );
    }
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
      await sqlExecutor.execute(
        `UPDATE ${table} SET identity_key = :to${keepTime} WHERE identity_key = :from`,
        { from, to },
        options
      );
    }
  }
  for (const change of body.changes) {
    if (change.before !== undefined) {
      const [current] = await readMatch(
        { table: change.table, match: change.key },
        options,
        ''
      );
      if (!sameRow(current ?? null, change.before)) {
        throw new Error(
          `Row ${change.table} ${canonicalJson(change.key)} differs before journal n=${body.n} (${body.kind})`
        );
      }
    }
    if (change.after === null) {
      const spec: TableSpec = JOURNAL_TABLES[change.table];
      const columns = Object.keys(change.key);
      await sqlExecutor.execute(
        `DELETE FROM ${spec.table} WHERE ${columns.map((c, i) => `\`${c}\` = :k${i}`).join(' AND ')}`,
        Object.fromEntries(columns.map((c, i) => [`k${i}`, change.key[c]])),
        options
      );
    } else {
      await writeRow(change.table, change.after, options);
    }
  }
}

/**
 * The hash of every identity table. Each table is summed in the database
 * (its row count, and the XOR of the first 64 bits of each row's SHA-256
 * over every column as text), so it never loads the tables into memory;
 * rows have unique keys, so none cancel out.
 */
export async function identityTablesHash(
  options: DbQueryOptions
): Promise<string> {
  const parts: Record<string, { rows: string; xor: string }> = {};
  for (const table of Object.keys(JOURNAL_TABLES) as JournalTable[]) {
    const spec: TableSpec = JOURNAL_TABLES[table];
    const fields = [
      ...spec.columns.map((c) => `IFNULL(CAST(\`${c}\` AS CHAR), '\\N')`),
      ...spec.times.map((t) => `IFNULL(${AS_TEXT(t)}, '\\N')`)
    ].join(', ');
    // The cursors table also holds go-live's marker and the journal's
    // counter, which are not state.
    const where =
      table === 'cursor'
        ? `WHERE id NOT IN ('writes-closed', '${JOURNAL_COUNTER_ID}')`
        : '';
    // Both as text: the XOR is a 64-bit unsigned number, which the driver
    // would hand back as a BigInt.
    const [sum] = await sqlExecutor.execute<{
      row_count: number | string;
      row_xor: number | string | null;
    }>(
      `SELECT CAST(COUNT(*) AS CHAR) AS row_count,
              LPAD(HEX(BIT_XOR(CAST(CONV(LEFT(SHA2(CONCAT_WS('|', ${fields}), 256), 16), 16, 10) AS UNSIGNED))), 16, '0') AS row_xor
         FROM ${spec.table} ${where}`,
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

/**
 * The daily checkpoint, with no long lock: lock the counter for a moment
 * (no write can take an `n` meanwhile), open a consistent snapshot on a
 * second connection, release the counter, hash the snapshot, then append
 * `{through_n, state_sha256}` as a write of its own.
 */
export async function journalCheckpoint(): Promise<{
  through_n: number;
  state_sha256: string;
}> {
  let lockHeld!: () => void;
  const counterLocked = new Promise<void>((resolve) => (lockHeld = resolve));
  let snapshotOpen!: () => void;
  const snapshotReady = new Promise<void>(
    (resolve) => (snapshotOpen = resolve)
  );
  let lockReleased!: () => void;
  const released = new Promise<void>((resolve) => (lockReleased = resolve));
  const hashing = sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      const options = { wrappedConnection: connection };
      await counterLocked;
      // The first plain read opens this transaction's snapshot.
      await sqlExecutor.execute(
        `SELECT id FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} LIMIT 1`,
        {},
        options
      );
      snapshotOpen();
      await released;
      return identityTablesHash(options);
    }
  );
  let throughN = 0;
  try {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      const [row] = await sqlExecutor.execute<{ block: number | string }>(
        `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id FOR UPDATE`,
        { id: JOURNAL_COUNTER_ID },
        options
      );
      throughN = Number(row?.block ?? 0);
      lockHeld();
      await snapshotReady;
    });
  } finally {
    lockHeld();
    snapshotOpen();
    lockReleased();
  }
  const stateSha256 = await hashing;
  await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    journal(
      {
        kind: 'checkpoint',
        inputs: {},
        checkpoint: { through_n: throughN, state_sha256: stateSha256 }
      },
      { wrappedConnection: connection }
    )
  );
  return { through_n: throughN, state_sha256: stateSha256 };
}

/** Journal entries must be posted within this long; go-live and the loops check. */
export const JOURNAL_POSTING_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Whether journal entries reach the records wave: the record log's closer
 * is on, and no journal entry has waited unposted longer than
 * JOURNAL_POSTING_MAX_AGE_MS. Until an entry is posted, losing the
 * database loses it.
 */
export async function journalPosting(
  nowMs: number = Date.now(),
  closerOn: boolean = process.env.FEATURE_SIGNED_RECORD_LOG === 'true'
): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
  const [oldest] = await sqlExecutor.execute<{ created_at: number | string }>(
    `SELECT MIN(created_at) AS created_at FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
      WHERE chain = 'public' AND segment_seq IS NULL
        AND lane IN (:lanes)`,
    { lanes: [JOURNAL_LANE, JOURNAL_SHADOW_LANE] }
  );
  const waitingSince =
    oldest?.created_at === null || oldest?.created_at === undefined
      ? null
      : Number(oldest.created_at);
  if (!closerOn) {
    return {
      ok: false,
      reason:
        'FEATURE_SIGNED_RECORD_LOG is off: journal entries are never posted'
    };
  }
  if (
    waitingSince !== null &&
    nowMs - waitingSince > JOURNAL_POSTING_MAX_AGE_MS
  ) {
    return {
      ok: false,
      reason: `a journal entry has waited ${Math.round((nowMs - waitingSince) / 60000)} minutes unposted`
    };
  }
  return { ok: true, reason: null };
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
