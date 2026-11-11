import {
  ARTIST_ARTWORK_ALERTS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_EVENT_EFFECTS_TABLE,
  COMPETITION_OUTBOX_TABLE
} from '@/constants';
import { stableUuid } from '@/competitions/competition-id';
import { COMPETITION_EVENT_EFFECTS_KEY_INDEX } from '@/entities/ICompetitionRuntime';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type ArtistArtworkAlertPair = {
  readonly subscriberId: string;
  readonly artistId: string;
};

export class ArtistArtworkAlertsDb extends LazyDbAccessCompatibleService {
  private async query<T>(
    operation: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const timer = `${this.constructor.name}->${operation}`;
    ctx.timer?.start(timer);
    try {
      return await this.db.execute<T>(sql, params, {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      });
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  async isEnabled(
    pair: ArtistArtworkAlertPair & { readonly submittedAt?: number },
    ctx: RequestContext = {}
  ): Promise<boolean> {
    const [row] = await this.query<{ enabled_at: number }>(
      'isEnabled',
      `select enabled_at from ${ARTIST_ARTWORK_ALERTS_TABLE}
       where subscriber_id = :subscriberId and artist_id = :artistId
       ${ctx.connection ? 'for update' : ''}`,
      pair,
      ctx
    );
    return (
      !!row &&
      (pair.submittedAt === undefined ||
        Number(row.enabled_at) < pair.submittedAt)
    );
  }

  async setEnabled(
    pair: ArtistArtworkAlertPair,
    enabled: boolean,
    ctx: RequestContext = {}
  ): Promise<void> {
    // Retrying enable preserves its original cutoff. Disable/re-enable starts
    // a fresh window, so delayed events cannot backfill older submissions.
    await this.query(
      'setEnabled',
      enabled
        ? `insert into ${ARTIST_ARTWORK_ALERTS_TABLE} (subscriber_id, artist_id, enabled_at)
           values (:subscriberId, :artistId, :now)
           on duplicate key update subscriber_id = values(subscriber_id)`
        : `delete from ${ARTIST_ARTWORK_ALERTS_TABLE}
           where subscriber_id = :subscriberId and artist_id = :artistId`,
      { ...pair, now: Date.now() },
      ctx
    );
  }

  async listPendingRecipients(
    eventId: string,
    entryId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const rows = await this.query<{ subscriber_id: string }>(
      'listPendingRecipients',
      `select a.subscriber_id from ${COMPETITION_ENTRIES_TABLE} e
       join ${ARTIST_ARTWORK_ALERTS_TABLE} a on a.artist_id = e.submitter_id
       where e.id = :entryId and a.enabled_at < e.submitted_at
         and a.subscriber_id <> a.artist_id
         and not exists (select 1 from ${COMPETITION_EVENT_EFFECTS_TABLE} f
           where f.event_id = :eventId and f.effect_key = concat('artwork:', a.subscriber_id)
             and f.completed_at is not null)
       order by a.subscriber_id asc limit 100`,
      { eventId, entryId },
      ctx
    );
    return rows.map((row) => row.subscriber_id);
  }

  async mergeProfile(
    source: string,
    target: string,
    ctx: RequestContext
  ): Promise<void> {
    if (source === target) return;
    if (!ctx.connection)
      throw new Error('Artwork preference merge requires a transaction');
    // Only unfinished events can run again. Transfer their receipts before
    // preferences, preserving the same receipt -> preference lock order as delivery.
    // Merges run for every consolidated identity, most of which never had a
    // receipt: read from the source's receipts by key, so the locking read
    // holds only those receipts, their outbox rows and the key's index range
    // (which holds back a new source receipt, and one whose key sorts right
    // next to it, until the merge commits), never every undelivered outbox row.
    const receipts = await this.query<{
      event_id: string;
      result: unknown;
      completed_at: number;
    }>(
      'mergeProfile',
      `select straight_join f.event_id, f.result, f.completed_at
       from ${COMPETITION_EVENT_EFFECTS_TABLE} f force index (${COMPETITION_EVENT_EFFECTS_KEY_INDEX})
       join ${COMPETITION_OUTBOX_TABLE} o on o.id = f.event_id
       where f.effect_key = :sourceKey and f.completed_at is not null and o.delivered_at is null
       order by o.id for update`,
      { sourceKey: `artwork:${source}` },
      ctx
    );
    for (const receipt of receipts) {
      const key = `artwork:${target}`;
      await this.query(
        'mergeProfile',
        `insert into ${COMPETITION_EVENT_EFFECTS_TABLE} (id,event_id,effect_key,result,completed_at)
         values (:id,:eventId,:key,:result,:completedAt)
         on duplicate key update result=if(completed_at is null,values(result),result),
           completed_at=coalesce(completed_at,values(completed_at))`,
        {
          id: stableUuid(receipt.event_id, key),
          eventId: receipt.event_id,
          key,
          result:
            typeof receipt.result === 'string'
              ? receipt.result
              : JSON.stringify(receipt.result),
          completedAt: receipt.completed_at
        },
        ctx
      );
    }
    // One statement per side, so each reads its own index (the primary key
    // for subscribers, artist_artwork_alert_recipients for artists) instead
    // of possibly scanning, and locking, the whole table for an OR.
    // Subscriber side: (source, x) becomes (target, x); self-pairs drop.
    await this.query(
      'mergeProfile',
      `insert into ${ARTIST_ARTWORK_ALERTS_TABLE} (subscriber_id,artist_id,enabled_at)
       select :target, a.artist_id, a.enabled_at
       from ${ARTIST_ARTWORK_ALERTS_TABLE} a where a.subscriber_id=:source
         and a.artist_id <> :source and a.artist_id <> :target
       on duplicate key update enabled_at=least(${ARTIST_ARTWORK_ALERTS_TABLE}.enabled_at,values(enabled_at))`,
      { source, target },
      ctx
    );
    // Artist side: (x, source) becomes (x, target); self-pairs drop.
    await this.query(
      'mergeProfile',
      `insert into ${ARTIST_ARTWORK_ALERTS_TABLE} (subscriber_id,artist_id,enabled_at)
       select a.subscriber_id, :target, a.enabled_at
       from ${ARTIST_ARTWORK_ALERTS_TABLE} a where a.artist_id=:source
         and a.subscriber_id <> :source and a.subscriber_id <> :target
       on duplicate key update enabled_at=least(${ARTIST_ARTWORK_ALERTS_TABLE}.enabled_at,values(enabled_at))`,
      { source, target },
      ctx
    );
    await this.query(
      'mergeProfile',
      `delete from ${ARTIST_ARTWORK_ALERTS_TABLE} where subscriber_id=:source`,
      { source },
      ctx
    );
    await this.query(
      'mergeProfile',
      `delete from ${ARTIST_ARTWORK_ALERTS_TABLE} where artist_id=:source`,
      { source },
      ctx
    );
  }
}

export const artistArtworkAlertsDb = new ArtistArtworkAlertsDb(dbSupplier);
