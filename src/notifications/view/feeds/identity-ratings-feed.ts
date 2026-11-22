import { DbPoolName } from '@/db-query.options';
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
 * the rating changes it applied. Three columns are still to come in
 * the mirror's table; until the table has
 * them this feed does not run in production, and IDENTITY_REP and
 * IDENTITY_NIC stay out of CAUSES_WITH_FEEDS:
 *
 * - block_time_ms: the block time of the change. created_at is the
 *   mirror's write time, which a rebuild of the mirror would change.
 * - origin: OPERATION (the rater's RATING_SET), CAP_CUT (the chain's
 *   TDH + xTDH cap) or IMPORT (the opening import, or a full sync at or
 *   below its height). Only operations notify, as today.
 * - one row per (height, rater, target, matter, category): the change's
 *   name, since the rows carry no transaction id.
 */
export interface RatingEventRow {
  readonly id: number;
  readonly height: number;
  /** Still to come in the mirror's table. */
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
  /** Still to come in the mirror's table. */
  readonly origin: 'OPERATION' | 'CAP_CUT' | 'IMPORT';
}

/** Where the feed reads rating events: the mirror's table, or a fake. */
export interface RatingEventSource {
  /** At most `limit` rows with an id above `afterId`, in id order. */
  readAfter(afterId: number, limit: number): Promise<RatingEventRow[]>;
}

/** The constant lives on the identity branch; this name is the same. */
const RATING_EVENTS_TABLE = 'identity_chain_rating_events';

/**
 * Rows are read only once they are this old. The mirror writes its events
 * in transactions and an id is taken before its transaction commits, so a
 * row could otherwise commit below a cursor that has passed it. The window
 * must cover the mirror's longest transaction.
 */
export const RATING_EVENTS_SETTLE_MS = 10_000;

/** Reads identity_chain_rating_events from the writer. */
export class MirrorRatingEventSource
  extends LazyDbAccessCompatibleService
  implements RatingEventSource
{
  async readAfter(afterId: number, limit: number): Promise<RatingEventRow[]> {
    const rows = await this.db.execute<Record<string, any>>(
      `select id, height, block_time_ms, rater_profile_id, target_profile_id,
              matter, matter_category, old_rating, new_rating, total_after, origin
       from ${RATING_EVENTS_TABLE}
       where id > :afterId and created_at <= :settled
       order by id
       limit ${Math.max(1, Math.floor(limit))}`,
      {
        afterId,
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
      origin: row.origin
    }));
  }
}

const ORIGINS: Record<RatingEventRow['origin'], ChainOrigin> = {
  OPERATION: 'OPERATION',
  CAP_CUT: 'SCAN',
  IMPORT: 'IMPORT'
};

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
    // An origin the feed does not know never notifies.
    origin: ORIGINS[row.origin] ?? 'IMPORT',
    matter,
    raterId: row.rater_profile_id,
    targetId: row.target_profile_id,
    category,
    oldValue: row.old_rating,
    newValue: row.new_rating,
    totalAfter: row.total_after
  };
}

/** `identity:ratings`: IDENTITY_REP and IDENTITY_NIC from the identity mirror. */
export class IdentityRatingsFeed implements NotificationFeed<RatingChangedEvent> {
  readonly name = 'identity:ratings';

  constructor(private readonly source: RatingEventSource) {}

  async read(
    after: string | null,
    limit: number
  ): Promise<FeedBatch<RatingChangedEvent>> {
    const rows = await this.source.readAfter(Number(after ?? 0), limit);
    const last = rows.at(-1);
    return {
      events: rows.map(ratingEventOf),
      next: last ? String(last.id) : null
    };
  }

  async derive(event: RatingChangedEvent): Promise<DerivedGroup> {
    return deriveRating(event);
  }
}

export const identityRatingsFeed = new IdentityRatingsFeed(
  new MirrorRatingEventSource(dbSupplier)
);
