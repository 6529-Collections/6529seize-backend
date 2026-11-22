import {
  toApiDeviceGrantProof,
  toApiDeviceSignedEvent
} from '@/api/device-signing/device-signing.mappers';
import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  DROP_AUTHOR_SIGNATURES_TABLE,
  DROPS_TABLE,
  WAVE_RELAY_CURSORS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  ContentModerationDb,
  contentModerationDb
} from '@/content-moderation/content-moderation.db';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import {
  ConnectionWrapper,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import {
  CandidateEvent,
  PublishableEvent,
  PublishableEventsSource,
  RelayCursor,
  RelayCursorStore,
  START_CURSOR
} from './wave-relay-publisher';

interface CandidateRow extends DeviceSignedEventEntity {
  readonly drop_author_id: string | null;
  readonly drop_signed: number | string | null;
}

interface CursorRow {
  readonly relay: string;
  readonly last_created_at: number | string;
  readonly last_event_id: string;
  readonly published: number | string;
  readonly rejected: number | string;
  readonly skipped: number | string;
  readonly last_error: string | null;
  readonly stuck_event_id: string | null;
  readonly stuck_count: number | string;
}

export interface WaveRelayPublishDbOptions {
  /**
   * Publish events of members-only waves (a read group, or under a wave
   * with one) too: only to relays that serve them to their members alone.
   */
  readonly includeMembersOnly: boolean;
}

/**
 * The publisher's reads and its per-relay cursors. Reads run on the writer
 * in one transaction, so an event, its drop and the drop's signature are
 * read as they stand now. Events of direct-message waves are never read:
 * legacy plaintext DMs stay off the relays.
 */
export class WaveRelayPublishDb
  extends LazyDbAccessCompatibleService
  implements RelayCursorStore
{
  constructor(
    supplier: () => SqlExecutor,
    private readonly moderation: Pick<
      ContentModerationDb,
      'getPresentations'
    > = contentModerationDb
  ) {
    super(supplier);
  }

  source(options: WaveRelayPublishDbOptions): PublishableEventsSource {
    return {
      candidatesAfter: (cursor, before, limit) =>
        this.candidatesAfter(cursor, before, limit, options),
      grants: (ids) => this.grants(ids)
    };
  }

  async candidatesAfter(
    cursor: Pick<RelayCursor, 'createdAt' | 'eventId'>,
    before: number,
    limit: number,
    { includeMembersOnly }: WaveRelayPublishDbOptions
  ): Promise<CandidateEvent[]> {
    return this.executeNativeQueriesInTransaction(async (connection) => {
      const rows = await this.db.execute<CandidateRow>(
        `select e.*, d.author_id as drop_author_id,
            (das.drop_id is not null) as drop_signed
          from ${DEVICE_SIGNED_EVENTS_TABLE} e
          join ${WAVES_TABLE} w on w.id = e.wave_id
          left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id
          left join ${DROPS_TABLE} d on d.id = e.drop_id
          left join ${DROP_AUTHOR_SIGNATURES_TABLE} das on das.drop_id = e.drop_id
          where coalesce(w.is_direct_message, 0) = 0
            and coalesce(pw.is_direct_message, 0) = 0
            ${
              includeMembersOnly
                ? ''
                : 'and w.visibility_group_id is null and pw.visibility_group_id is null'
            }
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
        },
        { wrappedConnection: connection }
      );
      const visible = await this.visibleDropIds(rows, connection);
      return rows.map((row) => {
        const { drop_author_id: _author, drop_signed, ...event } = row;
        return {
          event: toApiDeviceSignedEvent(
            event as DeviceSignedEventEntity
          ) as unknown as PublishableEvent,
          finalized: row.drop_id !== null,
          dropVisible: row.drop_id !== null && visible.has(row.drop_id),
          dropSigned: Number(drop_signed ?? 0) === 1
        };
      });
    });
  }

  /** Drops a reader who is not signed in can see, as the API decides it. */
  private async visibleDropIds(
    rows: CandidateRow[],
    connection: ConnectionWrapper<any>
  ): Promise<Set<string>> {
    const drops = rows
      .filter((row) => row.drop_id !== null && row.drop_author_id !== null)
      .map((row) => ({ id: row.drop_id!, author_id: row.drop_author_id! }));
    const unique = Array.from(
      new Map(drops.map((drop) => [drop.id, drop])).values()
    );
    const presentations = await this.moderation.getPresentations(
      unique,
      null,
      connection
    );
    return new Set(
      unique
        // No verdict: the API shows the drop (its default presentation).
        .filter((drop) => presentations[drop.id]?.moderation.can_view ?? true)
        .map((drop) => drop.id)
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
      skipped: Number(row.skipped),
      lastError: row.last_error,
      stuckEventId: row.stuck_event_id,
      stuckCount: Number(row.stuck_count)
    };
  }

  async save(relay: string, cursor: RelayCursor): Promise<void> {
    await this.db.execute(
      `insert into ${WAVE_RELAY_CURSORS_TABLE}
         (relay, last_created_at, last_event_id, published, rejected, skipped,
          last_error, stuck_event_id, stuck_count, updated_at)
       values (:relay, :createdAt, :eventId, :published, :rejected, :skipped,
          :lastError, :stuckEventId, :stuckCount, :now)
       on duplicate key update
         last_created_at = :createdAt,
         last_event_id = :eventId,
         published = :published,
         rejected = :rejected,
         skipped = :skipped,
         last_error = :lastError,
         stuck_event_id = :stuckEventId,
         stuck_count = :stuckCount,
         updated_at = :now`,
      {
        relay,
        createdAt: cursor.createdAt,
        eventId: cursor.eventId,
        published: cursor.published,
        rejected: cursor.rejected,
        skipped: cursor.skipped,
        lastError: cursor.lastError?.slice(0, 2000) ?? null,
        stuckEventId: cursor.stuckEventId,
        stuckCount: cursor.stuckCount,
        now: Date.now()
      }
    );
  }
}
