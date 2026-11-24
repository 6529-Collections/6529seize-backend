import {
  CHAIN_DECISION_LEADERBOARDS_TABLE,
  CHAIN_DECISIONS_TABLE,
  CHAIN_ENTRIES_TABLE,
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
  /**
   * Parts of the block at `feedNext` already applied: a block too large
   * for one batch is applied in parts, and a run that stops inside it goes
   * on from there.
   */
  readonly feedPart: number;
}

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
  feedPart: 0
};

const STATE_NAME = 'waves';
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
  readonly feed_part?: number | string | null;
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
      feedPart: Number(row.feed_part ?? 0)
    };
  }

  async saveState(state: WavesChainIndexState, now: number): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_CHAIN_INDEX_STATE_TABLE}
         (name, generation, full_phase, full_after, full_from_height,
          last_full_at, feed_next, read_height, network, last_error,
          feed_part, updated_at)
       values (:name, :generation, :fullPhase, :fullAfter, :fullFromHeight,
          :lastFullAt, :feedNext, :readHeight, :network, :lastError,
          :feedPart, :now)
       on duplicate key update
         generation = :generation, full_phase = :fullPhase,
         full_after = :fullAfter, full_from_height = :fullFromHeight,
         last_full_at = :lastFullAt, feed_next = :feedNext,
         read_height = :readHeight, network = :network,
         last_error = :lastError, feed_part = :feedPart,
         updated_at = :now`,
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
        feedPart: state.feedPart,
        now
      }
    );
  }

  /**
   * Keeps the finalized block time of the height the run reads at
   * (read_time, beside read_height): readers of which waves the chain
   * holds (waves-chain-mapping.ts) tell from it how far the index has read
   * the chain. Saved after read_height, so a run that stops between the two
   * leaves an earlier time, never a later one.
   */
  async saveReadTime(readTime: number): Promise<void> {
    await this.db.execute(
      `update ${WAVES_CHAIN_INDEX_STATE_TABLE} set read_time = :readTime
        where name = :name`,
      { name: STATE_NAME, readTime }
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

  /** Removes every row (a relaunched chain). */
  async clearAll(): Promise<void> {
    for (const { name } of Object.values(INDEX_TABLES)) {
      await this.db.execute(`delete from ${name}`);
    }
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

  /** Every row of a table, key order (tests and the rebuild check). */
  async dump(table: IndexTableName): Promise<IndexRow[]> {
    const { name, keys } = INDEX_TABLES[table];
    return this.db.execute<IndexRow>(
      `select * from ${name} order by ${keys.map(quoted).join(', ')}`
    );
  }
}

export const wavesChainIndexDb = new WavesChainIndexDb(dbSupplier);
