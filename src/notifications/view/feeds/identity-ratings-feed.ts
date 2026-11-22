import { DbPoolName } from '@/db-query.options';
import { Logger } from '@/logging';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';
import type { DerivedGroup } from '@/notifications/view/derived-notification';
import type {
  FeedBatch,
  NotificationFeed
} from '@/notifications/view/notification-feed-runner';
import type {
  ChainOrigin,
  RatingChangedEvent
} from '@/notifications/view/notification-sources';
import { deriveRating } from '@/notifications/view/rules/chain-rules';

/**
 * One row of identity_chain_rating_events, the identity mirror's log of
 * the rating changes it applies, one row per (height, rater, target,
 * matter, category). The table lands with the identity mirror; until it
 * has block_time_ms, origin and by_import, this feed does not run in
 * production, and IDENTITY_REP and IDENTITY_NIC stay out of
 * CAUSES_WITH_FEEDS, so their old writer keeps writing them.
 */
export interface RatingEventRow {
  readonly id: number;
  readonly height: number;
  /** The block's time; created_at is the mirror's write time. */
  readonly block_time_ms: number;
  readonly rater_profile_id: string;
  readonly target_profile_id: string;
  /** REP, or CIC (6529.io's name for NIC). */
  readonly matter: string;
  /** The REP category; CIC for NIC. */
  readonly matter_category: string;
  readonly old_rating: number;
  readonly new_rating: number;
  readonly total_after: number;
  /**
   * Who wrote the record: OPERATION (the rater's RATING_SET), CAP_CUT (the
   * chain's TDH + xTDH cap) or IMPORT. UNKNOWN until nodes record it.
   */
  readonly origin: 'OPERATION' | 'CAP_CUT' | 'IMPORT' | 'UNKNOWN';
  /** The opening import, or a full sync at or below its height. */
  readonly by_import: boolean;
}

/** Where a read resumes: the last row's height and id. */
export interface RatingCursor {
  readonly height: number;
  readonly id: number;
}

/** Where the feed reads rating events: the mirror's table, or a fake. */
export interface RatingEventSource {
  /** At most `limit` rows after the cursor, in (height, id) order. */
  readAfter(after: RatingCursor, limit: number): Promise<RatingEventRow[]>;
  /** At most `limit` rows from this height on, in (height, id) order. */
  readFromHeight(height: number, limit: number): Promise<RatingEventRow[]>;
  /** The height of the row with this id, or null when there is none. */
  heightOf(id: number): Promise<number | null>;
}

const RATING_EVENTS_TABLE = 'identity_chain_rating_events';

/**
 * Rows are read only once they are this old. The mirror writes its events
 * in transactions and an id is taken before its transaction commits, so a
 * row could otherwise commit below a cursor that has passed it. One
 * process writes the table, a transaction at a time, each well under this.
 */
export const RATING_EVENTS_SETTLE_MS = 10_000;

const COLUMNS = `id, height, block_time_ms, rater_profile_id, target_profile_id,
  matter, matter_category, old_rating, new_rating, total_after, origin, by_import`;

/** Reads identity_chain_rating_events from the writer. */
export class MirrorRatingEventSource
  extends LazyDbAccessCompatibleService
  implements RatingEventSource
{
  async readAfter(
    after: RatingCursor,
    limit: number
  ): Promise<RatingEventRow[]> {
    return this.read(
      `(height > :height or (height = :height and id > :id))`,
      { height: after.height, id: after.id },
      limit
    );
  }

  async readFromHeight(
    height: number,
    limit: number
  ): Promise<RatingEventRow[]> {
    return this.read(`height >= :height`, { height }, limit);
  }

  async heightOf(id: number): Promise<number | null> {
    const row = await this.db.oneOrNull<{ height: number }>(
      `select height from ${RATING_EVENTS_TABLE} where id = :id`,
      { id },
      { forcePool: DbPoolName.WRITE }
    );
    return row ? Number(row.height) : null;
  }

  private async read(
    where: string,
    params: Record<string, number>,
    limit: number
  ): Promise<RatingEventRow[]> {
    const rows = await this.db.execute<Record<string, any>>(
      `select ${COLUMNS}
       from ${RATING_EVENTS_TABLE}
       where ${where} and created_at <= :settled
       order by height, id
       limit ${Math.max(1, Math.floor(limit))}`,
      {
        ...params,
        settled: Time.currentMillis() - RATING_EVENTS_SETTLE_MS
      },
      { forcePool: DbPoolName.WRITE }
    );
    return rows.map((row) => ({
      id: Number(row.id),
      height: Number(row.height),
      block_time_ms: Number(row.block_time_ms),
      rater_profile_id: row.rater_profile_id,
      target_profile_id: row.target_profile_id,
      matter: row.matter,
      matter_category: row.matter_category,
      old_rating: Number(row.old_rating),
      new_rating: Number(row.new_rating),
      total_after: Number(row.total_after),
      origin: row.origin,
      by_import: Boolean(row.by_import)
    }));
  }
}

/** The rule's origin: only a rater's own change notifies, as today. */
function originOf(row: RatingEventRow): ChainOrigin {
  if (row.by_import) return 'IMPORT';
  switch (row.origin) {
    case 'OPERATION':
      return 'OPERATION';
    case 'CAP_CUT':
      return 'SCAN';
    case 'IMPORT':
      return 'IMPORT';
    default:
      return 'UNKNOWN';
  }
}

/** A mirror row as the rating rule reads it. */
export function ratingEventOf(row: RatingEventRow): RatingChangedEvent {
  const nic = row.matter === 'CIC';
  const matter = nic ? 'NIC' : 'REP';
  const category = nic ? '' : row.matter_category;
  return {
    height: row.height,
    // Within a height the mirror's id gives the order.
    txIndex: 0,
    blockTimeMs: row.block_time_ms,
    ref: [
      row.height,
      row.rater_profile_id,
      row.target_profile_id,
      matter,
      category
    ].join(':'),
    origin: originOf(row),
    matter,
    raterId: row.rater_profile_id,
    targetId: row.target_profile_id,
    category,
    oldValue: row.old_rating,
    newValue: row.new_rating,
    totalAfter: row.total_after
  };
}

const cursorOf = (row: RatingEventRow) => `${row.height}:${row.id}`;

function parseCursor(value: string | null): RatingCursor | null {
  if (!value) return null;
  const [height, id] = value.split(':').map(Number);
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(id)) {
    throw new Error(`Not a ratings cursor: ${value}`);
  }
  return { height, id };
}

/**
 * `identity:ratings`: IDENTITY_REP and IDENTITY_NIC from the identity
 * mirror. The cursor is the last row's (height, id). If that row is gone
 * or moved (the mirror's table was rebuilt and its ids renumbered), the
 * feed reads again from the cursor's height; rules give the same rows for
 * the same events, so the rows read twice change nothing.
 */
export class IdentityRatingsFeed implements NotificationFeed<RatingChangedEvent> {
  readonly name = 'identity:ratings';
  private readonly logger = Logger.get('IDENTITY_RATINGS_FEED');

  constructor(private readonly source: RatingEventSource) {}

  async read(
    after: string | null,
    limit: number
  ): Promise<FeedBatch<RatingChangedEvent>> {
    const cursor = parseCursor(after);
    let rows: RatingEventRow[];
    if (cursor === null) {
      rows = await this.source.readFromHeight(0, limit);
    } else if ((await this.source.heightOf(cursor.id)) === cursor.height) {
      rows = await this.source.readAfter(cursor, limit);
    } else {
      this.logger.warn(
        `[IDENTITY_RATINGS_CURSOR_RESET] row ${cursor.id} is not at height ${cursor.height}; reading again from that height`
      );
      rows = await this.source.readFromHeight(cursor.height, limit);
    }
    const last = rows.at(-1);
    return {
      events: rows.map(ratingEventOf),
      next: last ? cursorOf(last) : null
    };
  }

  async derive(event: RatingChangedEvent): Promise<DerivedGroup> {
    return deriveRating(event);
  }
}

export const identityRatingsFeed = new IdentityRatingsFeed(
  new MirrorRatingEventSource(dbSupplier)
);
