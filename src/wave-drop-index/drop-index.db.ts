import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  WAVE_RELAY_EVENTS_TABLE,
  WAVE_RELAY_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { CrpCursor } from '@/wave-relay-publish/crp-client';

/** A checked event, as the index stores it. */
export interface IngestRow {
  readonly event_id: string;
  readonly relay_id: string;
  readonly wave: string;
  readonly drop_id: string | null;
  readonly kind: number;
  readonly author: string;
  readonly device_key: string;
  readonly auth_ref: string;
  readonly seq: number;
  readonly claimed_time: number;
  readonly event: Record<string, unknown>;
  readonly grant_proof: Record<string, unknown>;
  readonly origin: 'site' | 'relay';
  readonly status: string;
  readonly status_reason: string | null;
  readonly received_at: number;
}

/** An event in the index, with its place in the index's order. */
export interface IngestedEvent extends IngestRow {
  readonly ingest_seq: number;
  readonly apply_attempts?: number;
}

interface StoredRow extends Omit<IngestedEvent, 'event' | 'grant_proof'> {
  readonly event: string | Record<string, unknown>;
  readonly grant_proof: string | Record<string, unknown>;
}

function json(
  value: string | Record<string, unknown>
): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toIngested(row: StoredRow): IngestedEvent {
  return {
    ...row,
    ingest_seq: Number(row.ingest_seq),
    apply_attempts: Number(row.apply_attempts ?? 0),
    kind: Number(row.kind),
    seq: Number(row.seq),
    claimed_time: Number(row.claimed_time),
    received_at: Number(row.received_at),
    event: json(row.event),
    grant_proof: json(row.grant_proof)
  };
}

export class DropIndexDb extends LazyDbAccessCompatibleService {
  /** Where the subscription to one relay stands, a cursor a wave. */
  async cursors(relayId: string): Promise<CrpCursor[]> {
    const rows = await this.db.execute<{
      wave: string;
      log_epoch: number | string;
      rseq: number | string;
    }>(
      `select wave, log_epoch, rseq from ${WAVE_RELAY_SUBSCRIPTIONS_TABLE}
        where relay_id = :relayId order by wave`,
      { relayId }
    );
    return rows.map((row) => ({
      wave: row.wave,
      logEpoch: Number(row.log_epoch),
      rseq: Number(row.rseq)
    }));
  }

  /** The grants 6529.io holds under these ids. */
  async knownGrants(
    ids: readonly string[]
  ): Promise<Map<string, DeviceGrantEntity>> {
    const found = new Map<string, DeviceGrantEntity>();
    if (!ids.length) return found;
    const rows = await this.db.execute<DeviceGrantEntity>(
      `select * from ${DEVICE_GRANTS_TABLE} where id in (:ids)`,
      { ids: Array.from(new Set(ids)) }
    );
    for (const row of rows) found.set(row.id.toLowerCase(), row);
    return found;
  }

  /**
   * The events written through 6529.io (device_signed_events), with the
   * drop each wrote (null while its write is unfinished).
   */
  async siteEvents(
    eventIds: readonly string[]
  ): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    if (!eventIds.length) return found;
    const rows = await this.db.execute<{ id: string; drop_id: string | null }>(
      `select id, drop_id from ${DEVICE_SIGNED_EVENTS_TABLE} where id in (:ids)`,
      { ids: Array.from(new Set(eventIds)) }
    );
    for (const row of rows) found.set(row.id.toLowerCase(), row.drop_id);
    return found;
  }

  /**
   * Stores the events the index does not hold yet and moves the cursors, in
   * one transaction. Returns the events stored now, in the index's order.
   */
  async ingest(
    rows: readonly IngestRow[],
    relayId: string,
    cursors: readonly CrpCursor[],
    now: number
  ): Promise<IngestedEvent[]> {
    return this.executeNativeQueriesInTransaction(async (connection) => {
      const opts = { wrappedConnection: connection };
      const added: string[] = [];
      // One writer (the loop runs once at a time): what the index holds is
      // read first, and a plain insert lets any bad value fail the batch.
      const held = new Set(
        rows.length
          ? (
              await this.db.execute<{ event_id: string }>(
                `select event_id from ${WAVE_RELAY_EVENTS_TABLE}
                  where event_id in (:ids)`,
                { ids: rows.map((row) => row.event_id) },
                opts
              )
            ).map((it) => it.event_id)
          : []
      );
      for (const row of rows) {
        if (held.has(row.event_id)) continue;
        held.add(row.event_id);
        await this.db.execute(
          `insert into ${WAVE_RELAY_EVENTS_TABLE}
             (event_id, relay_id, wave, drop_id, kind, author, device_key,
              auth_ref, seq, claimed_time, event, grant_proof, origin, status,
              status_reason, received_at)
           values (:event_id, :relay_id, :wave, :drop_id, :kind, :author,
              :device_key, :auth_ref, :seq, :claimed_time, :event,
              :grant_proof, :origin, :status, :status_reason, :received_at)`,
          {
            ...row,
            event: JSON.stringify(row.event),
            grant_proof: JSON.stringify(row.grant_proof)
          },
          opts
        );
        added.push(row.event_id);
      }
      for (const cursor of cursors) {
        // A cursor moves forward within its epoch; a new epoch replaces it.
        await this.db.execute(
          `insert into ${WAVE_RELAY_SUBSCRIPTIONS_TABLE}
             (relay_id, wave, log_epoch, rseq, updated_at)
           values (:relayId, :wave, :logEpoch, :rseq, :now) as new
           on duplicate key update
             rseq = if(new.log_epoch = ${WAVE_RELAY_SUBSCRIPTIONS_TABLE}.log_epoch,
                       greatest(${WAVE_RELAY_SUBSCRIPTIONS_TABLE}.rseq, new.rseq),
                       new.rseq),
             log_epoch = new.log_epoch,
             updated_at = new.updated_at`,
          { relayId, ...cursor, now },
          opts
        );
      }
      if (!added.length) return [];
      const stored = await this.db.execute<StoredRow>(
        `select * from ${WAVE_RELAY_EVENTS_TABLE}
          where event_id in (:ids) order by ingest_seq`,
        { ids: added },
        opts
      );
      return stored.map(toIngested);
    });
  }

  /**
   * Relay-only events written through 6529.io since they were read (the
   * author also sent them to 6529.io): marked `site`, with their drop.
   */
  async markSiteWritten(): Promise<number> {
    const result = await this.db.execute(
      `update ${WAVE_RELAY_EVENTS_TABLE} e
         join ${DEVICE_SIGNED_EVENTS_TABLE} d on d.id = e.event_id
          set e.origin = 'site', e.drop_id = coalesce(d.drop_id, e.drop_id)
        where e.origin = 'relay' and e.status = 'logged'`
    );
    return this.db.getAffectedRows(result);
  }

  /** Relay-only events not written into 6529.io's tables yet, in order. */
  async pendingRelayEvents(limit: number): Promise<IngestedEvent[]> {
    const rows = await this.db.execute<StoredRow>(
      `select * from ${WAVE_RELAY_EVENTS_TABLE}
        where origin = 'relay' and status = 'logged'
        order by ingest_seq limit :limit`,
      { limit }
    );
    return rows.map(toIngested);
  }

  /** Records what writing an event into 6529.io's tables came to. */
  async markApplied(
    ingestSeq: number,
    status: 'applied' | 'refused' | 'failed' | 'logged',
    reason: string | null,
    dropId: string | null
  ): Promise<void> {
    await this.db.execute(
      `update ${WAVE_RELAY_EVENTS_TABLE}
          set status = :status, status_reason = :reason,
              drop_id = coalesce(:dropId, drop_id),
              apply_attempts = apply_attempts + if(:status = 'applied', 0, 1)
        where ingest_seq = :ingestSeq`,
      { ingestSeq, status, reason: reason?.slice(0, 255) ?? null, dropId }
    );
  }

  /** The index's events after `ingestSeq`, in its order (its readers). */
  async eventsAfter(
    ingestSeq: number,
    limit: number
  ): Promise<IngestedEvent[]> {
    const rows = await this.db.execute<StoredRow>(
      `select * from ${WAVE_RELAY_EVENTS_TABLE}
        where ingest_seq > :ingestSeq order by ingest_seq limit :limit`,
      { ingestSeq, limit }
    );
    return rows.map(toIngested);
  }
}

export const dropIndexDb = new DropIndexDb(dbSupplier);
