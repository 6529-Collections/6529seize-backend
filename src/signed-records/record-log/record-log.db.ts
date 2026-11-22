import {
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SIGNED_RECORD_LOG_SEGMENTS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { RecordLogChain } from './record-log-format';

export interface RecordLogEntryRow {
  readonly id: number;
  readonly lane: string;
  readonly entry: string;
  readonly created_at: number;
}

export interface RecordLogSegmentRow {
  readonly chain: RecordLogChain;
  readonly seq: number;
  readonly sha256: string;
  readonly cid: string;
  readonly prev: string | null;
  readonly entries: number;
  readonly opened_at: number;
  readonly closed_at: number;
  readonly content: Buffer | null;
  readonly head_drop_id: string | null;
  readonly arweave_tx: string | null;
  readonly archive_drop_id: string | null;
}

/** The ids of the leading entries within maxBytes; at least the first. */
export function takeWithinBytes(
  sizes: readonly { readonly id: number; readonly bytes: number }[],
  maxBytes: number
): number[] {
  const ids: number[] = [];
  let total = 0;
  for (const { id, bytes } of sizes) {
    if (ids.length > 0 && total + bytes > maxBytes) {
      break;
    }
    ids.push(id);
    total += bytes;
  }
  return ids;
}

const withConnection = (ctx: RequestContext) =>
  ctx.connection ? { wrappedConnection: ctx.connection } : undefined;

/**
 * The executor hands a blob back as a Buffer or, after its JSON round trip,
 * as `{ type: 'Buffer', data: [...] }`; both become a Buffer.
 */
export function toBufferOrNull(value: unknown): Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const serialized = value as { type?: unknown; data?: unknown };
  if (serialized.type === 'Buffer' && Array.isArray(serialized.data)) {
    return Buffer.from(serialized.data as number[]);
  }
  throw new Error('A segment file is neither a Buffer nor a serialized one');
}

const toSegment = (row: Record<string, unknown>): RecordLogSegmentRow => ({
  chain: row.chain as RecordLogChain,
  seq: Number(row.seq),
  sha256: String(row.sha256),
  cid: String(row.cid),
  prev: (row.prev as string | null) ?? null,
  entries: Number(row.entries),
  opened_at: Number(row.opened_at),
  closed_at: Number(row.closed_at),
  content: toBufferOrNull(row.content),
  head_drop_id: (row.head_drop_id as string | null) ?? null,
  arweave_tx: (row.arweave_tx as string | null) ?? null,
  archive_drop_id: (row.archive_drop_id as string | null) ?? null
});

/** The record log's storage. The writer, segmenter and archiver use it. */
export class RecordLogDb extends LazyDbAccessCompatibleService {
  async insertEntries(
    rows: readonly {
      chain: RecordLogChain;
      lane: string;
      entry: string;
      created_at: number;
    }[],
    ctx: RequestContext
  ): Promise<void> {
    for (const row of rows) {
      await this.db.execute(
        `insert into ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
           (chain, lane, entry, created_at, segment_seq)
         values (:chain, :lane, :entry, :created_at, null)`,
        row,
        withConnection(ctx)
      );
    }
  }

  /**
   * The oldest open entries of a chain: at most `limit` of them and
   * `maxBytes` in all, but always the first one. Sizes are read first, so a
   * large backlog is never loaded whole.
   */
  async findOpenEntries(
    chain: RecordLogChain,
    limit: number,
    maxBytes: number,
    ctx: RequestContext
  ): Promise<RecordLogEntryRow[]> {
    const sizes = await this.db.execute<{ id: number; bytes: number }>(
      `select id, octet_length(entry) as bytes
       from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
       where chain = :chain and segment_seq is null
       order by id asc limit :limit`,
      { chain, limit },
      withConnection(ctx)
    );
    const ids = takeWithinBytes(
      sizes.map((row) => ({ id: Number(row.id), bytes: Number(row.bytes) })),
      maxBytes
    );
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db.execute<RecordLogEntryRow>(
      `select id, lane, entry, created_at from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
       where id in (:ids) order by id asc`,
      { ids },
      withConnection(ctx)
    );
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      created_at: Number(row.created_at)
    }));
  }

  /** Drops a segment's entries from the queue once its head is posted. */
  async deleteSegmentEntries(
    chain: RecordLogChain,
    seq: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `delete from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
       where chain = :chain and segment_seq = :seq`,
      { chain, seq },
      withConnection(ctx)
    );
  }

  async findLatestSegment(
    chain: RecordLogChain,
    ctx: RequestContext
  ): Promise<RecordLogSegmentRow | null> {
    const rows = await this.db.execute<Record<string, unknown>>(
      `select * from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}
       where chain = :chain order by seq desc limit 1`,
      { chain },
      withConnection(ctx)
    );
    return rows[0] ? toSegment(rows[0]) : null;
  }

  /**
   * Records a closed segment and claims its entries in one transaction.
   * Fails (and changes nothing) when another closer took the seq or an entry.
   */
  async insertSegmentClaimingEntries(
    segment: Omit<
      RecordLogSegmentRow,
      'head_drop_id' | 'arweave_tx' | 'archive_drop_id'
    >,
    entryIds: readonly number[]
  ): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      await this.db.execute(
        `insert into ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}
           (chain, seq, sha256, cid, prev, entries, opened_at, closed_at,
            content, head_drop_id, arweave_tx, archive_drop_id)
         values (:chain, :seq, :sha256, :cid, :prev, :entries, :opened_at,
            :closed_at, :content, null, null, null)`,
        { ...segment },
        { wrappedConnection: connection }
      );
      const result = await this.db.execute(
        `update ${SIGNED_RECORD_LOG_ENTRIES_TABLE} set segment_seq = :seq
         where chain = :chain and segment_seq is null and id in (:entryIds)`,
        { seq: segment.seq, chain: segment.chain, entryIds },
        { wrappedConnection: connection }
      );
      if (this.db.getAffectedRows(result) !== entryIds.length) {
        throw new Error(
          `Record log ${segment.chain} segment ${segment.seq}: entries were claimed elsewhere`
        );
      }
    });
  }

  async findSegmentsWithoutHead(
    ctx: RequestContext
  ): Promise<RecordLogSegmentRow[]> {
    const rows = await this.db.execute<Record<string, unknown>>(
      `select * from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}
       where head_drop_id is null order by chain asc, seq asc`,
      undefined,
      withConnection(ctx)
    );
    return rows.map(toSegment);
  }

  async setHeadDrop(
    chain: RecordLogChain,
    seq: number,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `update ${SIGNED_RECORD_LOG_SEGMENTS_TABLE} set head_drop_id = :dropId
       where chain = :chain and seq = :seq`,
      { chain, seq, dropId },
      withConnection(ctx)
    );
  }

  /** Segments with a posted head and no Arweave copy yet. */
  async findSegmentsToUpload(
    ctx: RequestContext
  ): Promise<RecordLogSegmentRow[]> {
    const rows = await this.db.execute<Record<string, unknown>>(
      `select * from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}
       where arweave_tx is null and head_drop_id is not null
       order by chain asc, seq asc`,
      undefined,
      withConnection(ctx)
    );
    return rows.map(toSegment);
  }

  async setArweaveTx(
    chain: RecordLogChain,
    seq: number,
    arweaveTx: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `update ${SIGNED_RECORD_LOG_SEGMENTS_TABLE} set arweave_tx = :arweaveTx
       where chain = :chain and seq = :seq`,
      { chain, seq, arweaveTx },
      withConnection(ctx)
    );
  }

  /** Segments on Arweave whose Arweave id no archive drop lists yet. */
  async findSegmentsToAnnounce(
    ctx: RequestContext
  ): Promise<RecordLogSegmentRow[]> {
    const rows = await this.db.execute<Record<string, unknown>>(
      `select * from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}
       where arweave_tx is not null and archive_drop_id is null
       order by chain asc, seq asc`,
      undefined,
      withConnection(ctx)
    );
    return rows.map(toSegment);
  }

  /** Keeps the archive drop and drops the stored file, now on Arweave. */
  async setArchiveDrop(
    segments: readonly { chain: RecordLogChain; seq: number }[],
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    for (const { chain, seq } of segments) {
      await this.db.execute(
        `update ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}
         set archive_drop_id = :dropId, content = null
         where chain = :chain and seq = :seq`,
        { chain, seq, dropId },
        withConnection(ctx)
      );
    }
  }
}

export const recordLogDb = new RecordLogDb(dbSupplier);
