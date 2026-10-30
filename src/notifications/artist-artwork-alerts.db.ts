import { ARTIST_ARTWORK_ALERTS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type ArtistArtworkAlertPair = {
  readonly subscriberId: string;
  readonly artistId: string;
};

export class ArtistArtworkAlertsDb extends LazyDbAccessCompatibleService {
  async isEnabled(
    pair: ArtistArtworkAlertPair,
    ctx: RequestContext = {},
    submittedAt?: number
  ): Promise<boolean> {
    const row = await this.db.oneOrNull<{ enabled_at: number }>(
      `select enabled_at from ${ARTIST_ARTWORK_ALERTS_TABLE}
       where subscriber_id = :subscriberId and artist_id = :artistId
       ${ctx.connection ? 'for update' : ''}`,
      pair,
      ctx.connection
        ? { wrappedConnection: ctx.connection }
        : { forcePool: DbPoolName.WRITE }
    );
    return (
      !!row &&
      (submittedAt === undefined || Number(row.enabled_at) < submittedAt)
    );
  }

  async setEnabled(
    pair: ArtistArtworkAlertPair,
    enabled: boolean,
    ctx: RequestContext = {}
  ): Promise<void> {
    // Retrying enable preserves its original cutoff. Disable/re-enable starts
    // a fresh window, so delayed events cannot backfill older submissions.
    await this.db.execute(
      enabled
        ? `insert into ${ARTIST_ARTWORK_ALERTS_TABLE} (subscriber_id, artist_id, enabled_at)
           values (:subscriberId, :artistId, :now)
           on duplicate key update subscriber_id = values(subscriber_id)`
        : `delete from ${ARTIST_ARTWORK_ALERTS_TABLE}
           where subscriber_id = :subscriberId and artist_id = :artistId`,
      { ...pair, now: Date.now() },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
  }

  async listRecipients(
    artistId: string,
    submittedAt: number,
    afterId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const rows = await this.db.execute<{ subscriber_id: string }>(
      `select subscriber_id from ${ARTIST_ARTWORK_ALERTS_TABLE}
       where artist_id = :artistId and enabled_at < :submittedAt
         and subscriber_id > :afterId and subscriber_id <> :artistId
       order by subscriber_id asc limit 250`,
      { artistId, submittedAt, afterId },
      ctx.connection
        ? { wrappedConnection: ctx.connection }
        : { forcePool: DbPoolName.WRITE }
    );
    return rows.map((row) => row.subscriber_id);
  }
}

export const artistArtworkAlertsDb = new ArtistArtworkAlertsDb(dbSupplier);
