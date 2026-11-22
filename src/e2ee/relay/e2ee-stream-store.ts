import {
  E2EE_RECORD_ITEMS_TABLE,
  E2EE_RELAY_DELETIONS_TABLE,
  E2EE_RELAY_OUTBOX_TABLE,
  E2EE_STREAMS_TABLE
} from '@/constants/db-tables';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

type Conn = ConnectionWrapper<unknown>;

/**
 * An outbox page holds at most this many bytes of content and payloads
 * (and at least one row), so a stream of large records never loads a
 * whole backlog at once.
 */
export const E2EE_OUTBOX_PAGE_BYTES = 8 * 1024 * 1024;

export interface E2eeStreamHead {
  readonly wave: string;
  readonly pos: number;
  readonly hash: string | null;
}

export interface E2eeOutboxInsert {
  readonly wave: string;
  readonly pos: number;
  readonly kind: number;
  readonly refs: readonly string[];
  readonly content: Buffer;
  readonly payload: Buffer | null;
  readonly logMeta: Record<string, unknown> | null;
  readonly createdAt: number;
}

export interface E2eeOutboxRow {
  readonly id: number;
  readonly wave: string;
  readonly pos: number;
  readonly kind: number;
  readonly refs: readonly string[];
  readonly content: Buffer;
  readonly payload: Buffer | null;
  readonly logMeta: Record<string, unknown> | null;
  /** The signed event JSON; null until first published. */
  readonly event: string | null;
  readonly heldBy: readonly string[];
  readonly attempts: number;
  readonly createdAt: number;
}

/** A DEL waiting for the relays. */
export interface E2eeDeletionRow {
  readonly id: number;
  readonly wave: string;
  readonly positions: readonly number[];
  readonly event: string | null;
  readonly heldBy: readonly string[];
}

/**
 * Events one DEL names. The relays take 1 to 64 distinct ids in a body of
 * at most 4 KiB; an id is 66 characters, so 58 of them make a body of
 * 4011 bytes (`{"ids":[...]}`), inside both limits.
 */
export const E2EE_DEL_MAX_IDS = 58;

/**
 * Stream heads and the publish outbox. Methods that take a connection run
 * inside the caller's transaction (the head stays locked until it commits).
 */
export interface E2eeStreamStore {
  /** Locks the stream's head row, creating it at position 0. */
  lockHead(
    wave: string,
    now: number,
    connection: Conn
  ): Promise<E2eeStreamHead>;
  saveHead(head: E2eeStreamHead, now: number, connection: Conn): Promise<void>;
  insertOutbox(row: E2eeOutboxInsert, connection: Conn): Promise<void>;
  /**
   * A stream's outbox rows after `afterPos`, in position order: at most
   * `limit` rows and `maxBytes` bytes, and always at least one row.
   */
  listOutbox(
    wave: string,
    limit: number,
    connection?: Conn,
    afterPos?: number,
    maxBytes?: number
  ): Promise<E2eeOutboxRow[]>;
  /** Waves with outbox rows, the longest waiting first. */
  listPendingWaves(limit: number): Promise<string[]>;
  /** Stores the signed event unless another process signed it first. */
  saveSignedEvent(id: number, event: string, connection?: Conn): Promise<void>;
  markHeld(
    ids: readonly number[],
    url: string,
    connection?: Conn
  ): Promise<void>;
  markFailed(ids: readonly number[], error: string): Promise<void>;
  deleteOutbox(ids: readonly number[], connection?: Conn): Promise<void>;
  /** Every stream head, for the side-by-side check. */
  listHeads(afterWave: string, limit: number): Promise<E2eeStreamHead[]>;
  /**
   * Heads that moved since `sinceMs` and have nothing left in the outbox
   * (every relay should hold them), newest first: the head check's sample.
   */
  recentHeads(sinceMs: number, limit: number): Promise<E2eeStreamHead[]>;
  countOutbox(): Promise<{ rows: number; oldestCreatedAt: number | null }>;
  /** The items a record carries, at its position (the DEL index). */
  insertItemKeys(
    wave: string,
    pos: number,
    keys: readonly string[],
    now: number,
    connection: Conn
  ): Promise<void>;
  /** Event ids of signed records, for their items' index rows. */
  saveEventIds(
    rows: readonly { wave: string; pos: number; eventId: string }[],
    connection?: Conn
  ): Promise<void>;
  /**
   * Queues DELs for the records that carry `keys` in `wave` (a key ending
   * in `*` matches a prefix). `keepLatest` leaves each key's newest record:
   * the one that carries the item as it now is.
   */
  queueDeletion(
    wave: string,
    keys: readonly string[],
    now: number,
    keepLatest: boolean,
    connection?: Conn
  ): Promise<number>;
  listDeletions(limit: number): Promise<E2eeDeletionRow[]>;
  /** Event ids by position (null while unsigned); positions still pending. */
  deletionTargets(
    wave: string,
    positions: readonly number[]
  ): Promise<{
    readonly eventIds: ReadonlyMap<number, string | null>;
    readonly pending: boolean;
  }>;
  saveDeletionEvent(id: number, event: string): Promise<void>;
  markDeletionHeld(id: number, url: string): Promise<void>;
  markDeletionFailed(id: number, error: string): Promise<void>;
  /** Drops a DEL every relay holds, and its records' index rows. */
  finishDeletion(row: E2eeDeletionRow): Promise<void>;
  countDeletions(): Promise<number>;
  /**
   * The queued record and the queued DEL that failed most often, with the
   * last error a relay gave for each: what the lag report names.
   */
  worstFailures(): Promise<E2eeRelayFailures>;
}

/** A queued record or DEL a relay refused or never answered, and why. */
export interface E2eeRelayFailure {
  readonly wave: string;
  readonly attempts: number;
  readonly lastError: string;
}

export interface E2eeRelayFailures {
  readonly outbox: E2eeRelayFailure | null;
  readonly deletion: E2eeRelayFailure | null;
}

interface OutboxDbRow {
  id: number | string;
  wave: string;
  pos: number | string;
  kind: number | string;
  refs: string;
  content_b64: string;
  payload_b64: string | null;
  log_meta: string | null;
  event: string | null;
  held_by: string;
  attempts: number | string;
  created_at: number | string;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function toOutboxRow(row: OutboxDbRow): E2eeOutboxRow {
  return {
    id: Number(row.id),
    wave: row.wave,
    pos: Number(row.pos),
    kind: Number(row.kind),
    refs: parseList(row.refs),
    content: Buffer.from((row.content_b64 ?? '').replace(/\s+/g, ''), 'base64'),
    payload:
      row.payload_b64 === null
        ? null
        : Buffer.from(row.payload_b64.replace(/\s+/g, ''), 'base64'),
    logMeta: row.log_meta ? JSON.parse(row.log_meta) : null,
    event: row.event,
    heldBy: parseList(row.held_by),
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at)
  };
}

export class MysqlE2eeStreamStore
  extends LazyDbAccessCompatibleService
  implements E2eeStreamStore
{
  private opts(connection?: Conn): DbQueryOptions {
    return connection
      ? { wrappedConnection: connection }
      : { forcePool: DbPoolName.WRITE };
  }

  async lockHead(
    wave: string,
    now: number,
    connection: Conn
  ): Promise<E2eeStreamHead> {
    // ON DUPLICATE KEY UPDATE takes the existing row's exclusive lock at
    // once. `insert ignore` took a shared lock first, so two writers of one
    // stream both held it and deadlocked on the `for update` below.
    await this.db.execute(
      `insert into ${E2EE_STREAMS_TABLE}
         (wave, head_pos, head_hash, created_at, updated_at)
       values (:wave, 0, null, :now, :now)
       on duplicate key update wave = wave`,
      { wave, now },
      this.opts(connection)
    );
    const rows = await this.db.execute<{
      head_pos: number | string;
      head_hash: string | null;
    }>(
      `select head_pos, head_hash from ${E2EE_STREAMS_TABLE}
       where wave = :wave for update`,
      { wave },
      this.opts(connection)
    );
    const row = rows[0];
    if (!row) throw new Error(`Stream head ${wave} vanished`);
    return { wave, pos: Number(row.head_pos), hash: row.head_hash };
  }

  async saveHead(
    head: E2eeStreamHead,
    now: number,
    connection: Conn
  ): Promise<void> {
    await this.db.execute(
      `update ${E2EE_STREAMS_TABLE}
       set head_pos = :pos, head_hash = :hash, updated_at = :now
       where wave = :wave`,
      { wave: head.wave, pos: head.pos, hash: head.hash, now },
      this.opts(connection)
    );
  }

  async insertOutbox(row: E2eeOutboxInsert, connection: Conn): Promise<void> {
    await this.db.execute(
      `insert into ${E2EE_RELAY_OUTBOX_TABLE}
         (wave, pos, kind, refs, content, payload, log_meta, event, held_by,
          attempts, last_error, created_at)
       values (:wave, :pos, :kind, :refs, :content, :payload, :logMeta, null,
               '[]', 0, null, :createdAt)`,
      {
        wave: row.wave,
        pos: row.pos,
        kind: row.kind,
        refs: JSON.stringify(row.refs),
        content: row.content,
        payload: row.payload,
        logMeta: row.logMeta ? JSON.stringify(row.logMeta) : null,
        createdAt: row.createdAt
      },
      this.opts(connection)
    );
  }

  async listOutbox(
    wave: string,
    limit: number,
    connection?: Conn,
    afterPos = 0,
    maxBytes = E2EE_OUTBOX_PAGE_BYTES
  ): Promise<E2eeOutboxRow[]> {
    const sizes = await this.db.execute<{
      id: number | string;
      bytes: number | string;
    }>(
      `select id, length(content) + coalesce(length(payload), 0) as bytes
       from ${E2EE_RELAY_OUTBOX_TABLE}
       where wave = :wave and pos > :afterPos order by pos limit :limit`,
      { wave, limit, afterPos },
      this.opts(connection)
    );
    const ids: number[] = [];
    let total = 0;
    for (const size of sizes) {
      total += Number(size.bytes);
      if (ids.length && total > maxBytes) break;
      ids.push(Number(size.id));
    }
    if (!ids.length) return [];
    const rows = await this.db.execute<OutboxDbRow>(
      `select id, wave, pos, kind, refs, to_base64(content) as content_b64,
         to_base64(payload) as payload_b64, log_meta, event, held_by,
         attempts, created_at
       from ${E2EE_RELAY_OUTBOX_TABLE}
       where id in (:ids) order by pos`,
      { ids },
      this.opts(connection)
    );
    return rows.map(toOutboxRow);
  }

  async listPendingWaves(limit: number): Promise<string[]> {
    const rows = await this.db.execute<{ wave: string }>(
      `select wave from ${E2EE_RELAY_OUTBOX_TABLE}
       group by wave order by min(created_at) limit :limit`,
      { limit },
      this.opts()
    );
    return rows.map((row) => row.wave);
  }

  async saveSignedEvent(
    id: number,
    event: string,
    connection?: Conn
  ): Promise<void> {
    await this.db.execute(
      `update ${E2EE_RELAY_OUTBOX_TABLE} set event = :event
       where id = :id and event is null`,
      { id, event },
      this.opts(connection)
    );
  }

  async markHeld(
    ids: readonly number[],
    url: string,
    connection?: Conn
  ): Promise<void> {
    if (!ids.length) return;
    await this.db.execute(
      `update ${E2EE_RELAY_OUTBOX_TABLE}
       set held_by = json_array_append(held_by, '$', :url)
       where id in (:ids) and not json_contains(held_by, json_quote(:url))`,
      { ids, url },
      this.opts(connection)
    );
  }

  async markFailed(ids: readonly number[], error: string): Promise<void> {
    if (!ids.length) return;
    await this.db.execute(
      `update ${E2EE_RELAY_OUTBOX_TABLE}
       set attempts = attempts + 1, last_error = :error
       where id in (:ids)`,
      { ids, error: error.slice(0, 255) },
      this.opts()
    );
  }

  async deleteOutbox(ids: readonly number[], connection?: Conn): Promise<void> {
    if (!ids.length) return;
    await this.db.execute(
      `delete from ${E2EE_RELAY_OUTBOX_TABLE} where id in (:ids)`,
      { ids },
      this.opts(connection)
    );
  }

  async listHeads(afterWave: string, limit: number): Promise<E2eeStreamHead[]> {
    const rows = await this.db.execute<{
      wave: string;
      head_pos: number | string;
      head_hash: string | null;
    }>(
      `select wave, head_pos, head_hash from ${E2EE_STREAMS_TABLE}
       where wave > :afterWave order by wave limit :limit`,
      { afterWave, limit },
      this.opts()
    );
    return rows.map((row) => ({
      wave: row.wave,
      pos: Number(row.head_pos),
      hash: row.head_hash
    }));
  }

  async recentHeads(sinceMs: number, limit: number): Promise<E2eeStreamHead[]> {
    const rows = await this.db.execute<{
      wave: string;
      head_pos: number | string;
      head_hash: string | null;
    }>(
      `select s.wave, s.head_pos, s.head_hash from ${E2EE_STREAMS_TABLE} s
       where s.updated_at >= :sinceMs and s.head_pos > 0
         and not exists (select 1 from ${E2EE_RELAY_OUTBOX_TABLE} o
                         where o.wave = s.wave)
       order by s.updated_at desc limit :limit`,
      { sinceMs, limit },
      this.opts()
    );
    return rows.map((row) => ({
      wave: row.wave,
      pos: Number(row.head_pos),
      hash: row.head_hash
    }));
  }

  async countOutbox(): Promise<{
    rows: number;
    oldestCreatedAt: number | null;
  }> {
    const rows = await this.db.execute<{
      cnt: number | string;
      oldest: number | string | null;
    }>(
      `select count(*) as cnt, min(created_at) as oldest
       from ${E2EE_RELAY_OUTBOX_TABLE}`,
      {},
      this.opts()
    );
    const row = rows[0];
    return {
      rows: Number(row?.cnt ?? 0),
      oldestCreatedAt:
        row?.oldest === null || row?.oldest === undefined
          ? null
          : Number(row.oldest)
    };
  }

  async insertItemKeys(
    wave: string,
    pos: number,
    keys: readonly string[],
    now: number,
    connection: Conn
  ): Promise<void> {
    if (!keys.length) return;
    const params: Record<string, unknown> = { wave, pos, now };
    const values = keys.map((key, index) => {
      params[`k${index}`] = key;
      return `(:wave, :pos, :k${index}, null, :now)`;
    });
    await this.db.execute(
      `insert ignore into ${E2EE_RECORD_ITEMS_TABLE}
         (wave, pos, item_key, event_id, created_at)
       values ${values.join(', ')}`,
      params,
      this.opts(connection)
    );
  }

  async saveEventIds(
    rows: readonly { wave: string; pos: number; eventId: string }[],
    connection?: Conn
  ): Promise<void> {
    for (const row of rows) {
      await this.db.execute(
        `update ${E2EE_RECORD_ITEMS_TABLE} set event_id = :eventId
         where wave = :wave and pos = :pos and event_id is null`,
        row,
        this.opts(connection)
      );
    }
  }

  async queueDeletion(
    wave: string,
    keys: readonly string[],
    now: number,
    keepLatest: boolean,
    connection?: Conn
  ): Promise<number> {
    if (!keys.length) return 0;
    const params: Record<string, unknown> = { wave };
    const matches = keys.map((key, index) => {
      params[`k${index}`] = key.endsWith('*') ? `${key.slice(0, -1)}%` : key;
      return key.endsWith('*')
        ? `item_key like :k${index}`
        : `item_key = :k${index}`;
    });
    const rows = await this.db.execute<{
      pos: number | string;
      item_key: string;
    }>(
      `select pos, item_key from ${E2EE_RECORD_ITEMS_TABLE}
       where wave = :wave and (${matches.join(' or ')}) order by pos`,
      params,
      this.opts(connection)
    );
    const latest = new Map<string, number>();
    for (const row of rows) {
      latest.set(
        row.item_key,
        Math.max(latest.get(row.item_key) ?? 0, Number(row.pos))
      );
    }
    const positions = Array.from(
      new Set(
        rows
          .filter(
            (row) => !keepLatest || Number(row.pos) !== latest.get(row.item_key)
          )
          .map((row) => Number(row.pos))
      )
    ).sort((a, b) => a - b);
    for (let at = 0; at < positions.length; at += E2EE_DEL_MAX_IDS) {
      await this.db.execute(
        `insert into ${E2EE_RELAY_DELETIONS_TABLE}
           (wave, positions, event, held_by, attempts, last_error, created_at)
         values (:wave, :positions, null, '[]', 0, null, :now)`,
        {
          wave,
          positions: JSON.stringify(positions.slice(at, at + E2EE_DEL_MAX_IDS)),
          now
        },
        this.opts(connection)
      );
    }
    return positions.length;
  }

  async listDeletions(limit: number): Promise<E2eeDeletionRow[]> {
    const rows = await this.db.execute<{
      id: number | string;
      wave: string;
      positions: string;
      event: string | null;
      held_by: string;
    }>(
      `select id, wave, positions, event, held_by
       from ${E2EE_RELAY_DELETIONS_TABLE} order by id limit :limit`,
      { limit },
      this.opts()
    );
    return rows.map((row) => ({
      id: Number(row.id),
      wave: row.wave,
      positions: parseList(row.positions).map(Number),
      event: row.event,
      heldBy: parseList(row.held_by)
    }));
  }

  async deletionTargets(
    wave: string,
    positions: readonly number[]
  ): Promise<{
    readonly eventIds: ReadonlyMap<number, string | null>;
    readonly pending: boolean;
  }> {
    const ids = await this.db.execute<{
      pos: number | string;
      event_id: string | null;
    }>(
      `select pos, max(event_id) as event_id from ${E2EE_RECORD_ITEMS_TABLE}
       where wave = :wave and pos in (:positions) group by pos`,
      { wave, positions },
      this.opts()
    );
    const pending = await this.db.execute<{ n: number | string }>(
      `select count(*) as n from ${E2EE_RELAY_OUTBOX_TABLE}
       where wave = :wave and pos in (:positions)`,
      { wave, positions },
      this.opts()
    );
    return {
      eventIds: new Map(ids.map((row) => [Number(row.pos), row.event_id])),
      pending: Number(pending[0]?.n ?? 0) > 0
    };
  }

  async saveDeletionEvent(id: number, event: string): Promise<void> {
    await this.db.execute(
      `update ${E2EE_RELAY_DELETIONS_TABLE} set event = :event
       where id = :id and event is null`,
      { id, event },
      this.opts()
    );
  }

  async markDeletionHeld(id: number, url: string): Promise<void> {
    await this.db.execute(
      `update ${E2EE_RELAY_DELETIONS_TABLE}
       set held_by = json_array_append(held_by, '$', :url)
       where id = :id and not json_contains(held_by, json_quote(:url))`,
      { id, url },
      this.opts()
    );
  }

  async markDeletionFailed(id: number, error: string): Promise<void> {
    await this.db.execute(
      `update ${E2EE_RELAY_DELETIONS_TABLE}
       set attempts = attempts + 1, last_error = :error where id = :id`,
      { id, error: error.slice(0, 255) },
      this.opts()
    );
  }

  async finishDeletion(row: E2eeDeletionRow): Promise<void> {
    await this.db.execute(
      `delete from ${E2EE_RECORD_ITEMS_TABLE}
       where wave = :wave and pos in (:positions)`,
      { wave: row.wave, positions: row.positions },
      this.opts()
    );
    await this.db.execute(
      `delete from ${E2EE_RELAY_DELETIONS_TABLE} where id = :id`,
      { id: row.id },
      this.opts()
    );
  }

  async countDeletions(): Promise<number> {
    const rows = await this.db.execute<{ n: number | string }>(
      `select count(*) as n from ${E2EE_RELAY_DELETIONS_TABLE}`,
      {},
      this.opts()
    );
    return Number(rows[0]?.n ?? 0);
  }

  async worstFailures(): Promise<E2eeRelayFailures> {
    const worst = async (table: string): Promise<E2eeRelayFailure | null> => {
      const rows = await this.db.execute<{
        wave: string;
        attempts: number | string;
        last_error: string;
      }>(
        `select wave, attempts, last_error from ${table}
         where last_error is not null
         order by attempts desc, id limit 1`,
        {},
        this.opts()
      );
      const row = rows[0];
      return row
        ? {
            wave: row.wave,
            attempts: Number(row.attempts),
            lastError: row.last_error
          }
        : null;
    };
    return {
      outbox: await worst(E2EE_RELAY_OUTBOX_TABLE),
      deletion: await worst(E2EE_RELAY_DELETIONS_TABLE)
    };
  }
}

export const e2eeStreamStore: E2eeStreamStore = new MysqlE2eeStreamStore(
  dbSupplier
);
