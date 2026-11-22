import {
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
}

export const e2eeStreamStore: E2eeStreamStore = new MysqlE2eeStreamStore(
  dbSupplier
);
