import { IDENTITY_CHAIN_RATING_EVENTS_TABLE } from '@/constants';
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
 * the rating changes it applies from the chain's feed, one row per
 * (height, rater, target, matter, category).
 */
export interface RatingEventRow {
  readonly id: number;
  readonly height: number;
  /** The block's time, which the notification shows. */
  readonly block_time_ms: number;
  readonly rater_principal: string;
  readonly target_principal: string;
  /** Null until the mirror has mapped the principal to a profile. */
  readonly rater_profile_id: string | null;
  readonly target_profile_id: string | null;
  /** REP, or CIC (6529.io's name for NIC). */
  readonly matter: string;
  /** The REP category; empty for CIC. */
  readonly matter_category: string;
  readonly old_rating: number;
  readonly new_rating: number;
  /** The target's total in this matter and category after the change. */
  readonly total_after: number;
  /**
   * Who wrote the record: OPERATION (the rater's RATING_SET), CAP_CUT (the
   * chain's rating scan), IMPORT, or UNKNOWN (no writer, not the import).
   */
  readonly origin: 'OPERATION' | 'CAP_CUT' | 'IMPORT' | 'UNKNOWN';
  /** Written by the opening import. */
  readonly by_import: boolean;
  /** The mirror's write time. */
  readonly created_at: number;
}

/** Where a read resumes: the last row read, by id, and its height. */
export interface RatingCursor {
  readonly height: number;
  readonly id: number;
}

/** Where the feed reads rating events: the mirror's table, or a fake. */
export interface RatingEventSource {
  /**
   * The last of the next `span` settled rows after `afterId`, in id order,
   * or null when there are none.
   */
  scanEnd(afterId: number, span: number): Promise<RatingCursor | null>;
  /**
   * At most `limit` rows in (afterId, upToId] that can notify anyone: a
   * rater's own change, not the import's. In id order.
   */
  readNotifying(
    afterId: number,
    upToId: number,
    limit: number
  ): Promise<RatingEventRow[]>;
  /** The rows with these ids that are still in the table. */
  readByIds(ids: readonly number[]): Promise<RatingEventRow[]>;
  /** The height of the row with this id, or null when there is none. */
  heightOf(id: number): Promise<number | null>;
}

const RATING_EVENTS_TABLE = IDENTITY_CHAIN_RATING_EVENTS_TABLE;

/**
 * Rows are read only once they are this old. The mirror writes its events
 * in transactions and an id is taken before its transaction commits, so a
 * row could otherwise commit below a cursor that has passed it. One
 * process writes the table, a transaction at a time, each well under this.
 */
export const RATING_EVENTS_SETTLE_MS = 10_000;

/**
 * Rows looked at per event read. The import writes a row for every rating
 * on 6529.io and none of them notifies, so a read skips them in the
 * database: one range of ids per batch, not one row at a time.
 */
export const RATING_EVENTS_SCAN_PER_EVENT = 25;

/**
 * A change whose rater or target the mirror has not mapped to a profile yet
 * waits in the cursor's pending list this long from its write, then is
 * dropped unnotified. The rows after it go on meanwhile.
 */
export const RATING_EVENTS_UNSETTLED_WAIT_MS = 15 * 60_000;

/** The most changes the cursor keeps waiting at once; the oldest go first. */
export const RATING_EVENTS_MAX_PENDING = 32;

/**
 * A rating's row is still pushed this long after its block. The mirror
 * applies ratings once per delegationsLoop run, and the feeds read them at
 * the end of that run; while the mirror's first full sync fills its runs, a
 * rating can reach the feed 5-15 minutes after its block.
 */
export const RATING_PUSH_WINDOW_MS = 30 * 60_000;

const COLUMNS = `id, height, block_time_ms, rater_principal, target_principal,
  rater_profile_id, target_profile_id, matter, matter_category, old_rating,
  new_rating, total_after, origin, by_import, created_at`;

/** Reads identity_chain_rating_events from the writer. */
export class MirrorRatingEventSource
  extends LazyDbAccessCompatibleService
  implements RatingEventSource
{
  async scanEnd(afterId: number, span: number): Promise<RatingCursor | null> {
    const row = await this.db.oneOrNull<{ id: number; height: number }>(
      `select id, height from ${RATING_EVENTS_TABLE}
       where id = (
         select max(id) from (
           select id from ${RATING_EVENTS_TABLE}
           where id > :afterId and created_at <= :settled
           order by id
           limit ${Math.max(1, Math.floor(span))}
         ) scanned
       )`,
      {
        afterId,
        settled: Time.currentMillis() - RATING_EVENTS_SETTLE_MS
      },
      { forcePool: DbPoolName.WRITE }
    );
    return row ? { id: Number(row.id), height: Number(row.height) } : null;
  }

  async readNotifying(
    afterId: number,
    upToId: number,
    limit: number
  ): Promise<RatingEventRow[]> {
    const rows = await this.db.execute<Record<string, any>>(
      `select ${COLUMNS}
       from ${RATING_EVENTS_TABLE}
       where id > :afterId and id <= :upToId
         and origin = 'OPERATION' and by_import = false
       order by id
       limit ${Math.max(1, Math.floor(limit))}`,
      { afterId, upToId },
      { forcePool: DbPoolName.WRITE }
    );
    return rows.map(rowOf);
  }

  async readByIds(ids: readonly number[]): Promise<RatingEventRow[]> {
    if (!ids.length) return [];
    const rows = await this.db.execute<Record<string, any>>(
      `select ${COLUMNS} from ${RATING_EVENTS_TABLE}
       where id in (:ids) order by id`,
      { ids },
      { forcePool: DbPoolName.WRITE }
    );
    return rows.map(rowOf);
  }

  async heightOf(id: number): Promise<number | null> {
    const row = await this.db.oneOrNull<{ height: number }>(
      `select height from ${RATING_EVENTS_TABLE} where id = :id`,
      { id },
      { forcePool: DbPoolName.WRITE }
    );
    return row ? Number(row.height) : null;
  }
}

function rowOf(row: Record<string, any>): RatingEventRow {
  return {
    id: Number(row.id),
    height: Number(row.height),
    block_time_ms: Number(row.block_time_ms),
    rater_principal: row.rater_principal,
    target_principal: row.target_principal,
    rater_profile_id: row.rater_profile_id ?? null,
    target_profile_id: row.target_profile_id ?? null,
    matter: row.matter,
    matter_category: row.matter_category,
    old_rating: Number(row.old_rating),
    new_rating: Number(row.new_rating),
    total_after: Number(row.total_after),
    origin: row.origin,
    by_import: Boolean(row.by_import),
    created_at: Number(row.created_at)
  };
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

/** A row whose rater and target the mirror has mapped to profiles. */
export type SettledRatingEventRow = RatingEventRow & {
  readonly rater_profile_id: string;
  readonly target_profile_id: string;
};

const isSettled = (row: RatingEventRow): row is SettledRatingEventRow =>
  row.rater_profile_id !== null && row.target_profile_id !== null;

/**
 * A mirror row as the rating rule reads it. The change is named by the
 * mirror's key, which uses principals, so a profile merge renames nothing.
 */
export function ratingEventOf(row: SettledRatingEventRow): RatingChangedEvent {
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
      row.rater_principal,
      row.target_principal,
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

/** A cursor: the last row looked at, and the changes still waiting. */
interface RatingsFeedCursor extends RatingCursor {
  readonly pending: readonly number[];
}

const cursorOf = (row: RatingCursor, pending: readonly number[]) =>
  `${row.height}:${row.id}${pending.length ? `|${pending.join(',')}` : ''}`;

function parseCursor(value: string | null): RatingsFeedCursor | null {
  if (!value) return null;
  const [position, waiting = ''] = value.split('|');
  const [height, id] = position.split(':').map(Number);
  const pending = waiting ? waiting.split(',').map(Number) : [];
  if (
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(id) ||
    !pending.every(Number.isSafeInteger)
  ) {
    throw new Error(`Not a ratings cursor: ${value}`);
  }
  return { height, id, pending };
}

/**
 * `identity:ratings`: IDENTITY_REP and IDENTITY_NIC from the identity
 * mirror. It reads in id order, the order the mirror wrote, so a row the
 * mirror writes later at a lower height is still read.
 *
 * The cursor is the last row looked at, by (height, id), and the changes
 * waiting for the mirror to map their rater or target to a profile: each
 * read reads those again, so they notify once mapped, while the rows after
 * them go on. If the cursor's row is gone or moved (the mirror's table was
 * rebuilt and its ids renumbered), the feed reads the table again from the
 * start; rules give the same rows for the same events, so the rows read
 * twice change nothing.
 */
export class IdentityRatingsFeed implements NotificationFeed<RatingChangedEvent> {
  readonly name = 'identity:ratings';
  readonly pushWindowMs = RATING_PUSH_WINDOW_MS;
  private readonly logger = Logger.get('IDENTITY_RATINGS_FEED');

  constructor(
    private readonly source: RatingEventSource,
    private readonly now: () => number = () => Time.currentMillis()
  ) {}

  async read(
    after: string | null,
    limit: number
  ): Promise<FeedBatch<RatingChangedEvent>> {
    let cursor = parseCursor(after);
    if (
      cursor !== null &&
      (await this.source.heightOf(cursor.id)) !== cursor.height
    ) {
      this.logger.warn(
        `[IDENTITY_RATINGS_CURSOR_RESET] row ${cursor.id} is not at height ${cursor.height}; reading again from the start`
      );
      cursor = null;
    }
    const settled: SettledRatingEventRow[] = [];
    const waiting: RatingEventRow[] = [];
    const sort = (rows: readonly RatingEventRow[]) => {
      for (const row of rows) {
        if (isSettled(row)) settled.push(row);
        else waiting.push(row);
      }
    };
    sort(await this.source.readByIds(cursor?.pending ?? []));
    const end = await this.source.scanEnd(
      cursor?.id ?? 0,
      limit * RATING_EVENTS_SCAN_PER_EVENT
    );
    let last: RatingCursor | null = cursor;
    if (end !== null) {
      const rows = await this.source.readNotifying(
        cursor?.id ?? 0,
        end.id,
        limit
      );
      sort(rows);
      // A full batch stops at its last row; otherwise the whole range is read.
      last = rows.length >= limit ? rows[rows.length - 1] : end;
    }
    const pending = this.stillWaiting(waiting);
    const next = last === null ? null : cursorOf(last, pending);
    return {
      events: settled.map(ratingEventOf),
      next: next === after && !settled.length ? null : next
    };
  }

  /** The waiting changes to keep, newest last; the rest are dropped. */
  private stillWaiting(rows: readonly RatingEventRow[]): number[] {
    const fresh = rows.filter(
      (row) => row.created_at > this.now() - RATING_EVENTS_UNSETTLED_WAIT_MS
    );
    const kept = fresh.slice(-RATING_EVENTS_MAX_PENDING);
    for (const row of rows.filter((it) => !kept.includes(it))) {
      this.logger.error(
        `[IDENTITY_RATINGS_UNSETTLED_SKIPPED] row ${row.id}: rater or target still without a profile; it notifies nobody`
      );
    }
    return kept.map((row) => row.id);
  }

  async derive(event: RatingChangedEvent): Promise<DerivedGroup> {
    return deriveRating(event);
  }
}

export const identityRatingsFeed = new IdentityRatingsFeed(
  new MirrorRatingEventSource(dbSupplier)
);
