import {
  toApiDeviceGrantProof,
  toApiDeviceSignedEvent
} from '@/api/device-signing/device-signing.mappers';
import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  WAVE_RELAY_CURSORS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  PublishableEvent,
  PublishableEventsSource,
  RelayCursor,
  RelayCursorStore,
  START_CURSOR
} from './wave-relay-publisher';

interface CursorRow {
  readonly relay: string;
  readonly last_created_at: number | string;
  readonly last_event_id: string;
  readonly published: number | string;
  readonly rejected: number | string;
  readonly last_error: string | null;
}

/**
 * The publisher's reads and its per-relay cursors. Events of direct-message
 * waves (and of waves gone since) are never read: legacy plaintext DMs stay
 * off the relays.
 */
export class WaveRelayPublishDb
  extends LazyDbAccessCompatibleService
  implements PublishableEventsSource, RelayCursorStore
{
  async eventsAfter(
    cursor: Pick<RelayCursor, 'createdAt' | 'eventId'>,
    before: number,
    limit: number
  ): Promise<PublishableEvent[]> {
    const rows = await this.db.execute<DeviceSignedEventEntity>(
      `select e.* from ${DEVICE_SIGNED_EVENTS_TABLE} e
        join ${WAVES_TABLE} w on w.id = e.wave_id
        where coalesce(w.is_direct_message, 0) = 0
          and e.drop_id is not null
          and e.created_at < :before
          and (e.created_at > :createdAt
            or (e.created_at = :createdAt and e.id > :eventId))
        order by e.created_at asc, e.id asc
        limit :limit`,
      {
        before,
        createdAt: cursor.createdAt,
        eventId: cursor.eventId,
        limit
      }
    );
    return rows.map(
      (row) => toApiDeviceSignedEvent(row) as unknown as PublishableEvent
    );
  }

  async grants(ids: string[]): Promise<Map<string, unknown>> {
    if (!ids.length) return new Map();
    const rows = await this.db.execute<DeviceGrantEntity>(
      `select * from ${DEVICE_GRANTS_TABLE} where id in (:ids)`,
      { ids }
    );
    return new Map(rows.map((row) => [row.id, toApiDeviceGrantProof(row)]));
  }

  async load(relay: string): Promise<RelayCursor> {
    const row = await this.db.oneOrNull<CursorRow>(
      `select * from ${WAVE_RELAY_CURSORS_TABLE} where relay = :relay`,
      { relay }
    );
    if (!row) return START_CURSOR;
    return {
      createdAt: Number(row.last_created_at),
      eventId: row.last_event_id,
      published: Number(row.published),
      rejected: Number(row.rejected),
      lastError: row.last_error
    };
  }

  async save(relay: string, cursor: RelayCursor): Promise<void> {
    await this.db.execute(
      `insert into ${WAVE_RELAY_CURSORS_TABLE}
         (relay, last_created_at, last_event_id, published, rejected, last_error, updated_at)
       values (:relay, :createdAt, :eventId, :published, :rejected, :lastError, :now)
       on duplicate key update
         last_created_at = values(last_created_at),
         last_event_id = values(last_event_id),
         published = values(published),
         rejected = values(rejected),
         last_error = values(last_error),
         updated_at = values(updated_at)`,
      {
        relay,
        createdAt: cursor.createdAt,
        eventId: cursor.eventId,
        published: cursor.published,
        rejected: cursor.rejected,
        lastError: cursor.lastError,
        now: Date.now()
      }
    );
  }
}
