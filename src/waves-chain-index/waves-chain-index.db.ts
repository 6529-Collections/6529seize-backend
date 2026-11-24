import {
  CHAIN_CLAIM_BUILDS_TABLE,
  CHAIN_DECISION_LEADERBOARDS_TABLE,
  CHAIN_DECISIONS_TABLE,
  CHAIN_ENTRIES_TABLE,
  CHAIN_EVENTS_TABLE,
  CHAIN_GROUPS_TABLE,
  CHAIN_LEADERBOARD_ROWS_TABLE,
  CHAIN_POLLS_TABLE,
  CHAIN_RESULTS_TABLE,
  CHAIN_VOTES_TABLE,
  CHAIN_WAVE_REP_TABLE,
  CHAIN_WAVE_ROLES_TABLE,
  CHAIN_WAVES_TABLE,
  WAVES_CHAIN_INDEX_STATE_TABLE
} from '@/constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Logger } from '@/logging';
import { ClaimBuild, ClaimBuildMessage } from './waves-chain-index.claims';
import {
  ballotKey,
  ChainEvent,
  ChainEventKind,
  ChainEventOrigin,
  eventCursor,
  EventCursorError,
  ObjectInfo,
  parseEventCursor,
  ScanState,
  StoredBallot,
  StoredVote,
  UNKNOWN_SCAN,
  voteKey
} from './waves-chain-index.events';
import { VoteChange } from './waves-chain-index.feed';
import { hasKeys, IndexRow } from './waves-chain-index.rows';

/** One index table: its name and the columns that key a row. */
export interface IndexTable {
  readonly name: string;
  readonly keys: readonly string[];
}

export const INDEX_TABLES = {
  groups: { name: CHAIN_GROUPS_TABLE, keys: ['group_id'] },
  waves: { name: CHAIN_WAVES_TABLE, keys: ['wave_id'] },
  roles: {
    name: CHAIN_WAVE_ROLES_TABLE,
    keys: ['wave_id', 'role', 'principal_id']
  },
  polls: { name: CHAIN_POLLS_TABLE, keys: ['poll_id'] },
  waveRep: {
    name: CHAIN_WAVE_REP_TABLE,
    keys: ['wave_id', 'rater', 'category_id']
  },
  decisions: { name: CHAIN_DECISIONS_TABLE, keys: ['decision_id'] },
  entries: { name: CHAIN_ENTRIES_TABLE, keys: ['entry_id'] },
  votes: {
    name: CHAIN_VOTES_TABLE,
    keys: ['decision_id', 'entry_id', 'voter']
  },
  results: { name: CHAIN_RESULTS_TABLE, keys: ['decision_id', 'result_time'] },
  leaderboards: {
    name: CHAIN_DECISION_LEADERBOARDS_TABLE,
    keys: ['decision_id']
  },
  leaderboardRows: {
    name: CHAIN_LEADERBOARD_ROWS_TABLE,
    keys: ['decision_id', 'entry_id']
  }
} as const satisfies Record<string, IndexTable>;

export type IndexTableName = keyof typeof INDEX_TABLES;

/** The height a row was read at and the full read it belongs to. */
export interface RowStamp {
  readonly height: number;
  readonly generation: number;
}

export interface WavesChainIndexState {
  /** The full read in progress, or the last one completed. */
  readonly generation: number;
  /** A full read in progress: its phase and where it got to. */
  readonly fullPhase: string | null;
  readonly fullAfter: string | null;
  readonly fullFromHeight: number | null;
  /** When the last full read completed (ms); null before the first. */
  readonly lastFullAt: number | null;
  /** The next height the change feed is read from. */
  readonly feedNext: number | null;
  /** The highest height a run has read at; no run reads below it. */
  readonly readHeight: number | null;
  /** The chain's network id the rows come from. */
  readonly network: string | null;
  readonly lastError: string | null;
  /** The next height whose events the log doesn't hold yet. */
  readonly eventsNext: number | null;
  /**
   * The last full read that checked every row again (the first, or one
   * after a feed gap); until it completes, only rows of its generation tell
   * an event what was there before.
   */
  readonly trustFrom: number;
  /** The vote scan as the log last saw it (the events module). */
  readonly scanState: ScanState;
  /**
   * Entries whose vote records the node could not decode, to read whole
   * at the feed's height, and those votes (unknown to the log till then).
   */
  readonly voteRereads: VoteRereads;
  /**
   * Parts of the block at `feedNext` already applied: a block too large
   * for one batch is applied in parts, and a run that stops inside it goes
   * on from there.
   */
  readonly feedPart: number;
  /**
   * The waves import's start (ms), from the first run that read it
   * complete; null before.
   */
  readonly importStartedAt: number | null;
}

export interface VoteRereads {
  readonly entries: readonly string[];
  readonly votes: readonly string[];
}

const NO_REREADS: VoteRereads = { entries: [], votes: [] };

export const EMPTY_INDEX_STATE: WavesChainIndexState = {
  generation: 0,
  fullPhase: null,
  fullAfter: null,
  fullFromHeight: null,
  lastFullAt: null,
  feedNext: null,
  readHeight: null,
  network: null,
  lastError: null,
  eventsNext: null,
  trustFrom: 0,
  scanState: UNKNOWN_SCAN,
  voteRereads: NO_REREADS,
  feedPart: 0,
  importStartedAt: null
};

/** The index's state row (waves_chain_index_state.name). */
export const WAVES_CHAIN_INDEX_STATE_NAME = 'waves';
const STATE_NAME = WAVES_CHAIN_INDEX_STATE_NAME;
/** Rows a statement writes at most. */
const CHUNK_ROWS = 200;
/**
 * Bytes a statement carries at most, about: the RDS proxy pins a client
 * session after one over 16,384 bytes (db/proxy-session-pinning.ts).
 */
const CHUNK_BYTES = 12_000;

/** Groups rows into statements under CHUNK_ROWS and about CHUNK_BYTES. */
export function statementChunks<T>(
  rows: readonly T[],
  bytesOf: (row: T) => number
): T[][] {
  const out: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = bytesOf(row);
    if (
      chunk.length &&
      (chunk.length >= CHUNK_ROWS || bytes + size > CHUNK_BYTES)
    ) {
      out.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length) out.push(chunk);
  return out;
}

/** About the bytes a row takes in a statement. */
function rowBytes(row: IndexRow): number {
  let bytes = 0;
  for (const value of Object.values(row)) {
    bytes +=
      8 +
      (typeof value === 'string'
        ? value.length
        : value !== null && typeof value === 'object'
          ? JSON.stringify(value).length
          : 12);
  }
  return bytes;
}
const GUARD_COLUMNS = ['height', 'generation'];

const logger = Logger.get('WAVES_CHAIN_INDEX_DB');

/** JSON with every object's keys in order: what MySQL's JSON keeps. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : inner
  );
}

/** About the bytes an id takes in a statement. */
const ID_BYTES = 72;
/** Events a read returns at most. */
export const MAX_READ_EVENTS = 1000;
/**
 * Events one transaction writes at most: a block whose scan cut thousands
 * of votes is written in several. A batch's events are derived again the
 * same way until its last part has moved `events_next` (the index isn't
 * touched before that), so a part written twice changes nothing.
 */
const EVENTS_PER_TRANSACTION = 500;

const EVENT_COLUMNS = [
  'height',
  'seq',
  'block_time',
  'kind',
  'origin',
  'wave_id',
  'wave_legacy_id',
  'decision_id',
  'decision_legacy_id',
  'entry_id',
  'entry_legacy_id',
  'poll_id',
  'poll_legacy_id',
  'group_id',
  'group_legacy_id',
  'actor',
  'data'
] as const;

type EventColumn = (typeof EVENT_COLUMNS)[number];

function eventRow(event: ChainEvent): Record<EventColumn, unknown> {
  return {
    height: event.height,
    seq: event.seq,
    block_time: event.blockTime,
    kind: event.kind,
    origin: event.origin,
    wave_id: event.waveId,
    wave_legacy_id: event.waveLegacyId,
    decision_id: event.decisionId,
    decision_legacy_id: event.decisionLegacyId,
    entry_id: event.entryId,
    entry_legacy_id: event.entryLegacyId,
    poll_id: event.pollId,
    poll_legacy_id: event.pollLegacyId,
    group_id: event.groupId,
    group_legacy_id: event.groupLegacyId,
    actor: event.actor,
    data: JSON.stringify(event.data)
  };
}

function eventBytes(event: ChainEvent): number {
  return 800 + JSON.stringify(event.data).length;
}

type EventRowRead = Record<EventColumn, unknown>;

function jsonOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function eventOf(row: EventRowRead): ChainEvent {
  return {
    height: Number(row.height),
    seq: Number(row.seq),
    blockTime: Number(row.block_time),
    kind: String(row.kind) as ChainEventKind,
    origin: String(row.origin) as ChainEventOrigin,
    waveId: textOrNull(row.wave_id),
    waveLegacyId: textOrNull(row.wave_legacy_id),
    decisionId: textOrNull(row.decision_id),
    decisionLegacyId: textOrNull(row.decision_legacy_id),
    entryId: textOrNull(row.entry_id),
    entryLegacyId: textOrNull(row.entry_legacy_id),
    pollId: textOrNull(row.poll_id),
    pollLegacyId: textOrNull(row.poll_legacy_id),
    groupId: textOrNull(row.group_id),
    groupLegacyId: textOrNull(row.group_legacy_id),
    actor: textOrNull(row.actor),
    data: jsonOf(row.data)
  };
}

/** A transaction that deadlocks is tried this many times in all. */
const DEADLOCK_TRIES = 4;
const DEADLOCK_BACKOFF_MS = 25;

function isDeadlock(error: unknown): boolean {
  for (let e = error as any, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.code === 'ER_LOCK_DEADLOCK' || e.errno === 1213) return true;
    if (e.serverCode === 'ER_LOCK_DEADLOCK') return true;
  }
  return false;
}

/** What a leaderboard row says, to compare a stored row with a read one. */
function leaderboardRowKey(row: IndexRow): string {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return JSON.stringify([
    Number(row.rank),
    row.legacy_id ?? null,
    row.author ?? null,
    String(row.score),
    String(row.total),
    sortedKeys(data ?? null)
  ]);
}

/** A value with every object's keys in order (MySQL's JSON keeps none). */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortedKeys(v)])
    );
  }
  return value;
}

interface StateRow {
  readonly generation: number | string;
  readonly full_phase: string | null;
  readonly full_after: string | null;
  readonly full_from_height: number | string | null;
  readonly last_full_at: number | string | null;
  readonly feed_next: number | string | null;
  readonly read_height: number | string | null;
  readonly network: string | null;
  readonly last_error: string | null;
  readonly events_next?: number | string | null;
  readonly trust_from?: number | string | null;
  readonly scan_state?: string | null;
  readonly vote_rereads?: string | null;
  readonly feed_part?: number | string | null;
  readonly import_started_at?: number | string | null;
}

function voteRereadsOf(text: string | null | undefined): VoteRereads {
  if (!text) return NO_REREADS;
  try {
    const value = JSON.parse(text) as Partial<VoteRereads>;
    const strings = (list: unknown) =>
      Array.isArray(list)
        ? list.filter((item): item is string => typeof item === 'string')
        : [];
    return { entries: strings(value.entries), votes: strings(value.votes) };
  } catch {
    return NO_REREADS;
  }
}

function scanStateOf(text: string | null | undefined): ScanState {
  if (!text) return UNKNOWN_SCAN;
  try {
    const value = JSON.parse(text) as Partial<ScanState>;
    const num = (n: unknown) =>
      typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
    return {
      scanning: num(value.scanning),
      finishedDay: num(value.finishedDay),
      reducing: typeof value.reducing === 'string' ? value.reducing : null
    };
  } catch {
    return UNKNOWN_SCAN;
  }
}

function nullableNumber(
  value: number | string | null | undefined
): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function sqlValue(value: unknown): unknown {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function quoted(column: string): string {
  return `\`${column}\``;
}

/** The index tables and the index's own state. */
export class WavesChainIndexDb extends LazyDbAccessCompatibleService {
  async loadState(): Promise<WavesChainIndexState> {
    const row = await this.db.oneOrNull<StateRow>(
      `select * from ${WAVES_CHAIN_INDEX_STATE_TABLE} where name = :name`,
      { name: STATE_NAME }
    );
    if (!row) return EMPTY_INDEX_STATE;
    return {
      generation: Number(row.generation),
      fullPhase: row.full_phase,
      fullAfter: row.full_after,
      fullFromHeight: nullableNumber(row.full_from_height),
      lastFullAt: nullableNumber(row.last_full_at),
      feedNext: nullableNumber(row.feed_next),
      readHeight: nullableNumber(row.read_height),
      network: row.network,
      lastError: row.last_error,
      eventsNext: nullableNumber(row.events_next),
      trustFrom: Number(row.trust_from ?? 0),
      scanState: scanStateOf(row.scan_state),
      voteRereads: voteRereadsOf(row.vote_rereads),
      feedPart: Number(row.feed_part ?? 0),
      importStartedAt: nullableNumber(row.import_started_at)
    };
  }

  async saveState(state: WavesChainIndexState, now: number): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_CHAIN_INDEX_STATE_TABLE}
         (name, generation, full_phase, full_after, full_from_height,
          last_full_at, feed_next, read_height, network, last_error,
          events_next, trust_from, scan_state, vote_rereads, feed_part,
          import_started_at, updated_at)
       values (:name, :generation, :fullPhase, :fullAfter, :fullFromHeight,
          :lastFullAt, :feedNext, :readHeight, :network, :lastError,
          :eventsNext, :trustFrom, :scanState, :voteRereads, :feedPart,
          :importStartedAt, :now)
       on duplicate key update
         generation = :generation, full_phase = :fullPhase,
         full_after = :fullAfter, full_from_height = :fullFromHeight,
         last_full_at = :lastFullAt, feed_next = :feedNext,
         read_height = :readHeight, network = :network,
         last_error = :lastError, events_next = :eventsNext,
         trust_from = :trustFrom, scan_state = :scanState,
         vote_rereads = :voteRereads, feed_part = :feedPart,
         import_started_at = :importStartedAt, updated_at = :now`,
      {
        name: STATE_NAME,
        generation: state.generation,
        fullPhase: state.fullPhase,
        fullAfter: state.fullAfter,
        fullFromHeight: state.fullFromHeight,
        lastFullAt: state.lastFullAt,
        feedNext: state.feedNext,
        readHeight: state.readHeight,
        network: state.network,
        lastError: state.lastError?.slice(0, 2000) ?? null,
        eventsNext: state.eventsNext,
        trustFrom: state.trustFrom,
        scanState: JSON.stringify(state.scanState),
        voteRereads: JSON.stringify(state.voteRereads),
        feedPart: state.feedPart,
        importStartedAt: state.importStartedAt,
        now
      }
    );
  }

  /**
   * Writes rows, each stamped with the height it was read at and the full
   * read it belongs to. A row read at a lower height than the stored one
   * changes nothing but its generation (the reads of one run are pinned to
   * one height, and runs go up, so this only guards against going back).
   * Rows missing a key column are dropped.
   */
  async upsert(
    table: IndexTableName,
    rows: readonly IndexRow[],
    stamp: RowStamp,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const { name, keys } = INDEX_TABLES[table];
    const complete = rows.filter((row) => hasKeys(row, keys));
    if (!complete.length) return;
    const columns = [
      ...Object.keys(complete[0]).filter((c) => !GUARD_COLUMNS.includes(c)),
      ...GUARD_COLUMNS
    ];
    const keyed = new Set<string>(keys);
    // Assignments run left to right: height last, so the others compare
    // against the stored row's height.
    const updates = [
      ...columns
        .filter((c) => !keyed.has(c) && !GUARD_COLUMNS.includes(c))
        .map(
          (c) =>
            `${quoted(c)} = if(new.height >= ${name}.height, new.${quoted(c)}, ${name}.${quoted(c)})`
        ),
      `generation = greatest(${name}.generation, new.generation)`,
      `height = greatest(${name}.height, new.height)`
    ].join(', ');
    for (const chunk of statementChunks(complete, rowBytes)) {
      const params: Record<string, unknown> = {};
      const values = chunk.map((row, i) => {
        const placeholders = columns.map((column, j) => {
          const param = `p${i}_${j}`;
          params[param] =
            column === 'height'
              ? stamp.height
              : column === 'generation'
                ? stamp.generation
                : column === 'data'
                  ? JSON.stringify(row.data ?? null)
                  : sqlValue(row[column]);
          return `:${param}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await this.db.execute(
        `insert into ${name} (${columns.map(quoted).join(', ')})
         values ${values.join(', ')} as new
         on duplicate key update ${updates}`,
        params,
        connection ? { wrappedConnection: connection } : undefined
      );
    }
  }

  /** Deletes rows by their keys. */
  async remove(
    table: IndexTableName,
    keyRows: readonly IndexRow[],
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const { name, keys } = INDEX_TABLES[table];
    for (const row of keyRows) {
      if (!hasKeys(row, keys)) continue;
      await this.db.execute(
        `delete from ${name} where ${keys
          .map((k) => `${quoted(k)} = :${k}`)
          .join(' and ')}`,
        Object.fromEntries(keys.map((k) => [k, row[k]])),
        connection ? { wrappedConnection: connection } : undefined
      );
    }
  }

  /**
   * A transaction at READ COMMITTED (no gap locks: up to READ_CONCURRENCY
   * of them replace children at once, into empty tables on the first full
   * read), tried again on a deadlock.
   */
  private async childrenTransaction(
    work: (connection: ConnectionWrapper<any>) => Promise<void>
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.executeNativeQueriesInTransaction(work, {
          isolationLevel: 'READ COMMITTED'
        });
        return;
      } catch (error) {
        if (attempt >= DEADLOCK_TRIES || !isDeadlock(error)) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, DEADLOCK_BACKOFF_MS * attempt)
        );
      }
    }
  }

  /**
   * Replaces every row under one parent (a wave's roles, polls or wave
   * REP, an entry's votes) with these rows, in one transaction.
   */
  async replaceChildren(
    table: IndexTableName,
    parentColumn: string,
    parentId: string,
    rows: readonly IndexRow[],
    stamp: RowStamp
  ): Promise<void> {
    const { name } = INDEX_TABLES[table];
    await this.childrenTransaction(async (connection) => {
      await this.db.execute(
        `delete from ${name} where ${quoted(parentColumn)} = :parentId`,
        { parentId },
        { wrappedConnection: connection }
      );
      await this.upsert(table, rows, stamp, connection);
    });
  }

  /**
   * A decision's leaderboard rows: writes only the rows that moved or are
   * new and deletes the gone ones; the others only take the full read's
   * generation. Returns the rows written and deleted.
   */
  async writeLeaderboardRows(
    decisionId: string,
    rows: readonly IndexRow[],
    stamp: RowStamp
  ): Promise<number> {
    const { name } = INDEX_TABLES.leaderboardRows;
    let written = 0;
    await this.childrenTransaction(async (connection) => {
      written = 0;
      const stored = await this.db.execute<IndexRow>(
        `select entry_id, \`rank\`, legacy_id, author,
                cast(score as char) as score, cast(total as char) as total,
                data
           from ${name} where decision_id = :decisionId`,
        { decisionId },
        { wrappedConnection: connection }
      );
      const byEntry = new Map(stored.map((row) => [String(row.entry_id), row]));
      const changed = rows.filter((row) => {
        const was = byEntry.get(String(row.entry_id));
        return !was || leaderboardRowKey(was) !== leaderboardRowKey(row);
      });
      const kept = new Set(rows.map((row) => String(row.entry_id)));
      const gone = stored
        .map((row) => String(row.entry_id))
        .filter((entryId) => !kept.has(entryId));
      for (const chunk of statementChunks(gone, () => 80)) {
        await this.db.execute(
          `delete from ${name}
            where decision_id = :decisionId and entry_id in (:gone)`,
          { decisionId, gone: chunk },
          { wrappedConnection: connection }
        );
      }
      await this.upsert('leaderboardRows', changed, stamp, connection);
      await this.db.execute(
        `update ${name} set generation = :generation
          where decision_id = :decisionId and generation < :generation`,
        { decisionId, generation: stamp.generation },
        { wrappedConnection: connection }
      );
      written = changed.length + gone.length;
    });
    return written;
  }

  /**
   * The feed's vote records, as they are: a vote is set or deleted unless
   * the stored one is newer (a later full read got there first).
   */
  async applyVotes(
    changes: readonly VoteChange[],
    stamp: RowStamp
  ): Promise<void> {
    const sets = changes.filter((change) => change.value !== null);
    const deletes = changes.filter((change) => change.value === null);
    for (const chunk of statementChunks(sets, () => 240)) {
      const params: Record<string, unknown> = {
        height: stamp.height,
        generation: stamp.generation
      };
      const values = chunk.map((change, i) => {
        params[`d${i}`] = change.decisionId;
        params[`e${i}`] = change.entryId;
        params[`v${i}`] = change.voter;
        params[`x${i}`] = change.value;
        params[`u${i}`] = change.updatedHeight;
        return `(:d${i}, :e${i}, :v${i}, :x${i}, :u${i}, :height, :generation)`;
      });
      await this.db.execute(
        `insert into ${CHAIN_VOTES_TABLE}
           (decision_id, entry_id, voter, value, updated_height, height,
            generation)
         values ${values.join(', ')} as new
         on duplicate key update
           value = if(new.updated_height >= ${CHAIN_VOTES_TABLE}.updated_height,
             new.value, ${CHAIN_VOTES_TABLE}.value),
           generation = greatest(${CHAIN_VOTES_TABLE}.generation, new.generation),
           height = greatest(${CHAIN_VOTES_TABLE}.height, new.height),
           updated_height = greatest(${CHAIN_VOTES_TABLE}.updated_height,
             new.updated_height)`,
        params
      );
    }
    for (const change of deletes) {
      await this.db.execute(
        `delete from ${CHAIN_VOTES_TABLE}
          where decision_id = :decisionId and entry_id = :entryId
            and voter = :voter and updated_height <= :updatedHeight`,
        {
          decisionId: change.decisionId,
          entryId: change.entryId,
          voter: change.voter,
          updatedHeight: change.updatedHeight
        }
      );
    }
  }

  /** Removes every row the full read `generation` did not see. */
  async sweep(generation: number): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const [key, { name }] of Object.entries(INDEX_TABLES)) {
      const result = await this.db.execute(
        `delete from ${name} where generation < :generation`,
        { generation }
      );
      removed[key] = this.db.getAffectedRows(result);
    }
    return removed;
  }

  /** Removes every row and every event (a relaunched chain). */
  async clearAll(): Promise<void> {
    for (const { name } of Object.values(INDEX_TABLES)) {
      await this.db.execute(`delete from ${name}`);
    }
    await this.db.execute(`delete from ${CHAIN_EVENTS_TABLE}`);
  }

  /** The stored status of these decisions; absent ones are left out. */
  async decisionStatuses(
    ids: readonly string[]
  ): Promise<Map<string, { status: string; counted: boolean }>> {
    const found = new Map<string, { status: string; counted: boolean }>();
    if (!ids.length) return found;
    const rows = await this.db.execute<{
      decision_id: string;
      status: string;
      counted: number | string | null;
    }>(
      `select decision_id, status,
              json_unquote(json_extract(data, '$.counted')) = 'true' as counted
         from ${CHAIN_DECISIONS_TABLE} where decision_id in (:ids)`,
      { ids }
    );
    for (const row of rows) {
      found.set(row.decision_id, {
        status: row.status,
        counted: Number(row.counted) === 1
      });
    }
    return found;
  }

  /**
   * Objects whose answer moves with block time alone, stalest first: a
   * counted decision's `due` and its leaderboard's scores while it is live,
   * a role grant past its expiry (its `live`).
   */
  async timeDependent(now: number): Promise<{
    decisionIds: string[];
    roleWaveIds: string[];
  }> {
    const decisions = await this.db.execute<{ decision_id: string }>(
      `select decision_id from ${CHAIN_DECISIONS_TABLE}
        where json_unquote(json_extract(data, '$.counted')) = 'true'
          and (status = 'published' or due = 1
               or json_unquote(json_extract(data, '$.phase')) = 'settling')
        order by height, decision_id`
    );
    const roles = await this.db.execute<{ wave_id: string }>(
      `select wave_id from ${CHAIN_WAVE_ROLES_TABLE}
        where live = 1
          and cast(coalesce(json_unquote(json_extract(data, '$.expiresAt')), '0')
                   as unsigned) between 1 and :now
        group by wave_id
        order by min(height), wave_id`,
      { now }
    );
    return {
      decisionIds: decisions.map((row) => row.decision_id),
      roleWaveIds: roles.map((row) => row.wave_id)
    };
  }

  // ---------------------------------------------------------- the event log

  /**
   * What the index holds of the objects these events name: legacy ids and
   * the fields that never change once written.
   */
  async eventObjects(ids: {
    entries?: readonly string[];
    decisions?: readonly string[];
    waves?: readonly string[];
    polls?: readonly string[];
    groups?: readonly string[];
  }): Promise<{
    entries: Map<string, ObjectInfo>;
    decisions: Map<string, ObjectInfo>;
    waves: Map<string, ObjectInfo>;
    polls: Map<string, ObjectInfo>;
    groups: Map<string, ObjectInfo>;
  }> {
    const lower = (value: string | null) => value?.toLowerCase() ?? null;
    const code = (value: unknown) =>
      value === null || value === undefined ? null : Number(value);
    const entries = await this.byIds<{
      entry_id: string;
      legacy_id: string | null;
      decision_id: string;
      author: string;
      total: string;
      manifest_hash: string | null;
    }>(
      `select entry_id, legacy_id, decision_id, author,
              cast(total as char) as total,
              json_unquote(json_extract(data, '$.manifestHash'))
                as manifest_hash
         from ${CHAIN_ENTRIES_TABLE} where entry_id in (:ids)`,
      ids.entries
    );
    const decisions = await this.byIds<{
      decision_id: string;
      legacy_id: string | null;
      wave_id: string;
      status: string;
      height: number | string;
      credit_scope: unknown;
      credit_source: unknown;
    }>(
      `select decision_id, legacy_id, wave_id, status, height,
              json_extract(data, '$.config.creditScope') as credit_scope,
              json_extract(data, '$.config.creditSource') as credit_source
         from ${CHAIN_DECISIONS_TABLE} where decision_id in (:ids)`,
      ids.decisions
    );
    const waves = await this.byIds<{
      wave_id: string;
      legacy_id: string | null;
    }>(
      `select wave_id, legacy_id from ${CHAIN_WAVES_TABLE}
        where wave_id in (:ids)`,
      ids.waves
    );
    const polls = await this.byIds<{
      poll_id: string;
      legacy_id: string | null;
      wave_id: string;
    }>(
      `select poll_id, legacy_id, wave_id from ${CHAIN_POLLS_TABLE}
        where poll_id in (:ids)`,
      ids.polls
    );
    const groups = await this.byIds<{
      group_id: string;
      legacy_id: string | null;
    }>(
      `select group_id, legacy_id from ${CHAIN_GROUPS_TABLE}
        where group_id in (:ids)`,
      ids.groups
    );
    return {
      entries: new Map(
        entries.map((r) => [
          r.entry_id,
          {
            legacyId: lower(r.legacy_id),
            decisionId: r.decision_id,
            author: r.author,
            total: String(r.total),
            manifestHash: r.manifest_hash ?? null
          }
        ])
      ),
      decisions: new Map(
        decisions.map((r) => [
          r.decision_id,
          {
            legacyId: lower(r.legacy_id),
            waveId: r.wave_id,
            creditScope: code(r.credit_scope),
            creditSource: code(r.credit_source),
            status: r.status,
            statusHeight: Number(r.height)
          }
        ])
      ),
      waves: new Map(
        waves.map((r) => [r.wave_id, { legacyId: lower(r.legacy_id) }])
      ),
      polls: new Map(
        polls.map((r) => [
          r.poll_id,
          { legacyId: lower(r.legacy_id), waveId: r.wave_id }
        ])
      ),
      groups: new Map(
        groups.map((r) => [r.group_id, { legacyId: lower(r.legacy_id) }])
      )
    };
  }

  private async byIds<T>(
    sql: string,
    ids: readonly string[] | undefined
  ): Promise<T[]> {
    const out: T[] = [];
    for (const chunk of statementChunks(ids ?? [], () => ID_BYTES)) {
      out.push(...(await this.db.execute<T>(sql, { ids: chunk })));
    }
    return out;
  }

  /** The stored votes of these keys, by `voteKey`. */
  async eventVotes(
    keys: readonly { decisionId: string; entryId: string; voter: string }[]
  ): Promise<Map<string, StoredVote>> {
    const found = new Map<string, StoredVote>();
    for (const chunk of statementChunks(keys, () => 3 * ID_BYTES)) {
      const params: Record<string, unknown> = {};
      const tuples = chunk.map((key, i) => {
        params[`d${i}`] = key.decisionId;
        params[`e${i}`] = key.entryId;
        params[`v${i}`] = key.voter;
        return `(:d${i}, :e${i}, :v${i})`;
      });
      const rows = await this.db.execute<{
        decision_id: string;
        entry_id: string;
        voter: string;
        value: string;
        updated_height: number | string;
        generation: number | string;
      }>(
        `select decision_id, entry_id, voter, cast(value as char) as value,
                updated_height, generation
           from ${CHAIN_VOTES_TABLE}
          where (decision_id, entry_id, voter) in (${tuples.join(', ')})`,
        params
      );
      for (const row of rows) {
        found.set(voteKey(row.decision_id, row.entry_id, row.voter), {
          value: String(row.value),
          updatedHeight: Number(row.updated_height),
          generation: Number(row.generation)
        });
      }
    }
    return found;
  }

  /** The log's last ballot of each (poll, cluster) below `before`. */
  async lastBallots(
    keys: readonly { pollId: string; cid: string }[],
    before: number
  ): Promise<Map<string, StoredBallot>> {
    const found = new Map<string, StoredBallot>();
    for (const chunk of statementChunks(keys, () => 2 * ID_BYTES)) {
      const params: Record<string, unknown> = { before, kind: 'POLL_BALLOT' };
      const tuples = chunk.map((key, i) => {
        params[`p${i}`] = key.pollId;
        params[`c${i}`] = key.cid;
        return `(:p${i}, :c${i})`;
      });
      const rows = await this.db.execute<{
        poll_id: string;
        actor: string;
        data: unknown;
      }>(
        `select poll_id, actor, data from ${CHAIN_EVENTS_TABLE}
          where kind = :kind and (poll_id, actor) in (${tuples.join(', ')})
            and height < :before
          order by height desc, seq desc`,
        params
      );
      for (const row of rows) {
        const key = ballotKey(row.poll_id, row.actor);
        if (found.has(key)) continue;
        const data = jsonOf(row.data);
        found.set(key, {
          selection: Number(data.newSelection),
          version: Number(data.version)
        });
      }
    }
    return found;
  }

  /**
   * Appends a batch's events, in transactions of at most
   * EVENTS_PER_TRANSACTION events and statements under CHUNK_BYTES, then
   * moves `events_next` past the batch (never back) and keeps the scan
   * state with it, in the last transaction. A part written again (a run
   * stopped between parts) keeps the rows written before; one derived
   * otherwise is logged as an error (a batch is derived from the index
   * before any of it is applied, so that is a fault). Returns how many
   * events were derived otherwise.
   */
  async writeEvents(
    events: readonly ChainEvent[],
    eventsNext: number,
    scanState: ScanState,
    claimBuilds: readonly ClaimBuild[] = []
  ): Promise<number> {
    let otherwise = 0;
    const parts: ChainEvent[][] = [];
    for (let i = 0; i < events.length; i += EVENTS_PER_TRANSACTION) {
      parts.push(events.slice(i, i + EVENTS_PER_TRANSACTION));
    }
    if (!parts.length) parts.push([]);
    for (let p = 0; p < parts.length; p++) {
      await this.executeNativeQueriesInTransaction(async (connection) => {
        const fresh = parts[p].length
          ? await this.unwrittenEvents(parts[p], connection)
          : { events: [], otherwise: 0 };
        otherwise += fresh.otherwise;
        for (const chunk of statementChunks(fresh.events, eventBytes)) {
          const params: Record<string, unknown> = {};
          const values = chunk.map((event, i) => {
            const row = eventRow(event);
            return `(${EVENT_COLUMNS.map((column) => {
              params[`${column}_${i}`] = row[column];
              return `:${column}_${i}`;
            }).join(', ')})`;
          });
          await this.db.execute(
            `insert into ${CHAIN_EVENTS_TABLE} (${EVENT_COLUMNS.join(', ')})
             values ${values.join(', ')}`,
            params,
            { wrappedConnection: connection }
          );
        }
        if (p === parts.length - 1) {
          await this.insertClaimBuilds(claimBuilds, connection);
          await this.db.execute(
            `update ${WAVES_CHAIN_INDEX_STATE_TABLE}
                set events_next = greatest(coalesce(events_next, 0), :eventsNext),
                    scan_state = :scanState
              where name = :name`,
            {
              eventsNext,
              scanState: JSON.stringify(scanState),
              name: STATE_NAME
            },
            { wrappedConnection: connection }
          );
        }
      });
    }
    return otherwise;
  }

  /**
   * The events of a part (in the log's order) whose places the log doesn't
   * hold yet; an event the log holds otherwise is logged and counted.
   */
  private async unwrittenEvents(
    part: readonly ChainEvent[],
    connection: ConnectionWrapper<any>
  ): Promise<{ events: ChainEvent[]; otherwise: number }> {
    const first = part[0];
    const last = part[part.length - 1];
    const stored = await this.db.execute<EventRowRead>(
      `select * from ${CHAIN_EVENTS_TABLE}
        where (height > :h0 or (height = :h0 and seq >= :s0))
          and (height < :h1 or (height = :h1 and seq <= :s1))`,
      { h0: first.height, s0: first.seq, h1: last.height, s1: last.seq },
      { wrappedConnection: connection }
    );
    if (!stored.length) return { events: [...part], otherwise: 0 };
    const held = new Map(
      stored.map((row) => {
        const event = eventOf(row);
        return [eventCursor(event), event];
      })
    );
    const events: ChainEvent[] = [];
    let otherwise = 0;
    for (const event of part) {
      const was = held.get(eventCursor(event));
      if (!was) events.push(event);
      else if (sortedJson(was) !== sortedJson(event)) {
        otherwise++;
        logger.error(
          `[EVENT ${eventCursor(event)} DERIVED OTHERWISE] kept ${sortedJson(was)}, derived ${sortedJson(event)}`
        );
      }
    }
    return { events, otherwise };
  }

  /**
   * At most `limit` events after `after` (a cursor from `next`, or null
   * for the first), in the log's order, up to `appliedHeight`: the height
   * the index has applied, so every lookup a reader makes at an event's
   * height can see it. Events above it (logged by a run that stopped
   * before applying them) come once they are applied. `kinds` keeps those
   * kinds only, each read through the (kind, height, seq) index. `next` is
   * the cursor after the last event read (`after` when none), with the
   * log's network; a cursor of another network throws EventCursorError
   * (the chain was relaunched and the log started again: read from null).
   */
  async readEvents(
    after: string | null,
    limit: number,
    kinds?: readonly ChainEventKind[]
  ): Promise<{
    events: ChainEvent[];
    next: string | null;
    appliedHeight: number | null;
    network: string | null;
  }> {
    const place = parseEventCursor(after);
    const state = await this.loadState();
    if (place?.network && state.network && place.network !== state.network) {
      throw new EventCursorError(
        `${after}: a cursor of network ${place.network}; the log is ${state.network}'s`
      );
    }
    const appliedHeight = state.feedNext === null ? null : state.feedNext - 1;
    const read = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_READ_EVENTS));
    let events: ChainEvent[] = [];
    if (appliedHeight !== null) {
      const params: Record<string, unknown> = { limit: read, appliedHeight };
      const conditions = ['height <= :appliedHeight'];
      if (place) {
        conditions.push(
          '(height > :height or (height = :height and seq > :seq))'
        );
        params.height = place.height;
        params.seq = place.seq;
      }
      const select = async (kind?: ChainEventKind) =>
        (
          await this.db.execute<EventRowRead>(
            `select * from ${CHAIN_EVENTS_TABLE}
              where ${[...(kind ? ['kind = :kind'] : []), ...conditions].join(' and ')}
              order by height, seq limit :limit`,
            { ...params, kind }
          )
        ).map(eventOf);
      if (kinds?.length) {
        for (const kind of Array.from(new Set(kinds))) {
          events.push(...(await select(kind)));
        }
        events = events
          .sort((a, b) => a.height - b.height || a.seq - b.seq)
          .slice(0, read);
      } else {
        events = await select();
      }
    }
    return {
      events,
      next: events.length
        ? eventCursor(events[events.length - 1], state.network)
        : after,
      appliedHeight,
      network: state.network
    };
  }

  // ---------------------------------------------------------- claim builds

  /** Writes claim builds; one already there is kept as it is. */
  private async insertClaimBuilds(
    builds: readonly ClaimBuild[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const columns = [
      'network',
      'decision_id',
      'occurrence',
      'height',
      'entry_id',
      'drop_id',
      'message',
      'status',
      'reason'
    ];
    for (const chunk of statementChunks(builds, () => 1_200)) {
      const params: Record<string, unknown> = {};
      const values = chunk.map((build, i) => {
        const row: Record<string, unknown> = {
          network: build.network,
          decision_id: build.decisionId,
          occurrence: build.occurrence,
          height: build.height,
          entry_id: build.entryId,
          drop_id: build.dropId,
          message: build.message ? JSON.stringify(build.message) : null,
          status: build.status,
          reason: build.reason
        };
        return `(${columns
          .map((column) => {
            params[`${column}_${i}`] = row[column];
            return `:${column}_${i}`;
          })
          .join(', ')})`;
      });
      await this.db.execute(
        `insert into ${CHAIN_CLAIM_BUILDS_TABLE} (${columns.join(', ')})
         values ${values.join(', ')}
         on duplicate key update status = ${CHAIN_CLAIM_BUILDS_TABLE}.status`,
        params,
        { wrappedConnection: connection }
      );
    }
  }

  /** Claim builds still to send, oldest first. */
  async pendingClaimBuilds(limit: number): Promise<
    {
      network: string;
      decisionId: string;
      occurrence: number;
      message: ClaimBuildMessage;
      attempts: number;
    }[]
  > {
    const rows = await this.db.execute<{
      network: string;
      decision_id: string;
      occurrence: number | string;
      message: unknown;
      attempts: number | string;
    }>(
      `select network, decision_id, occurrence, message, attempts
         from ${CHAIN_CLAIM_BUILDS_TABLE}
        where status = 'pending'
        order by height, decision_id, occurrence
        limit :limit`,
      { limit }
    );
    return rows.map((row) => ({
      network: row.network,
      decisionId: row.decision_id,
      occurrence: Number(row.occurrence),
      message: jsonOf(row.message) as unknown as ClaimBuildMessage,
      attempts: Number(row.attempts)
    }));
  }

  /** A claim build went out: sent, with its message id. */
  async claimBuildSent(
    key: { network: string; decisionId: string; occurrence: number },
    messageId: string | null,
    now: number
  ): Promise<void> {
    await this.db.execute(
      `update ${CHAIN_CLAIM_BUILDS_TABLE}
          set status = 'sent', attempts = attempts + 1, sent_at = :now,
              message_id = :messageId, last_error = null
        where network = :network and decision_id = :decisionId
          and occurrence = :occurrence and status = 'pending'`,
      { ...key, messageId, now }
    );
  }

  /** A send failed: the build stays pending for the next run. */
  async claimBuildFailed(
    key: { network: string; decisionId: string; occurrence: number },
    error: string
  ): Promise<void> {
    await this.db.execute(
      `update ${CHAIN_CLAIM_BUILDS_TABLE}
          set attempts = attempts + 1, last_error = :error
        where network = :network and decision_id = :decisionId
          and occurrence = :occurrence and status = 'pending'`,
      { ...key, error: error.slice(0, 2000) }
    );
  }

  /** Every claim build (tests). */
  async claimBuildRows(): Promise<Record<string, unknown>[]> {
    return this.db.execute(
      `select * from ${CHAIN_CLAIM_BUILDS_TABLE}
        order by network, decision_id, occurrence`
    );
  }

  /** Every row of a table, key order (tests and the rebuild check). */
  async dump(table: IndexTableName): Promise<IndexRow[]> {
    const { name, keys } = INDEX_TABLES[table];
    return this.db.execute<IndexRow>(
      `select * from ${name} order by ${keys.map(quoted).join(', ')}`
    );
  }
}

export const wavesChainIndexDb = new WavesChainIndexDb(dbSupplier);
