import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  WAVE_RELAY_EVENTS_TABLE,
  WAVE_RELAY_REJECTS_TABLE,
  WAVE_RELAY_SUBSCRIPTIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DeviceEventKind } from '@/api/device-signing/device-event';
import { DbPoolName } from '@/db-query.options';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  chainIndexProgress,
  expectedChainNetwork,
  wavesOnChain
} from '@/waves-chain-index/waves-chain-mapping';
import { CrpCursor } from '@/wave-relay-publish/crp-client';
import type { WaveOnChain } from './relay-drop-applier';

export type EventOrigin = 'IMPORT' | 'OPERATION';

/** A checked event, as the index stores it. */
export interface IngestRow {
  readonly event_id: string;
  readonly relay_id: string;
  readonly wave: string;
  /** The relay's key for the wave (a UUID's derived chain id). */
  readonly wave_key: string | null;
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
  /**
   * IMPORT: claimed before switch-on (WAVES_DROP_INDEX_LIVE_FROM), history
   * written with no notifications; OPERATION: from switch-on on.
   */
  readonly event_origin: EventOrigin;
  readonly status: string;
  readonly status_reason: string | null;
  /** How its grant was checked: known, signature or unverifiable. */
  readonly grant_check: string | null;
  /** When its grant was revoked, if it was. */
  readonly grant_revoked_at: number | null;
  readonly received_at: number;
}

/** A copy that failed a check. */
export interface RejectRow {
  readonly event_id: string | null;
  readonly relay_id: string;
  readonly wave: string;
  readonly reason: string;
  readonly event: Record<string, unknown>;
  readonly grant_proof: Record<string, unknown>;
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
    grant_revoked_at:
      row.grant_revoked_at === null || row.grant_revoked_at === undefined
        ? null
        : Number(row.grant_revoked_at),
    event: json(row.event),
    grant_proof: json(row.grant_proof)
  };
}

/** One author's events a write batch takes at most. */
export const PENDING_PER_AUTHOR = 20;

/** A signed write finishes in seconds; one this old was cut off. */
const STALE_RESERVATION_MS = 15 * 60 * 1000;

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
    rejects: readonly RejectRow[],
    relayId: string,
    cursors: readonly CrpCursor[],
    now: number
  ): Promise<IngestedEvent[]> {
    return this.executeNativeQueriesInTransaction(async (connection) => {
      const opts = { wrappedConnection: connection };
      const added: string[] = [];
      for (const reject of rejects) {
        await this.db.execute(
          `insert into ${WAVE_RELAY_REJECTS_TABLE}
             (event_id, relay_id, wave, reason, event, grant_proof,
              received_at)
           values (:event_id, :relay_id, :wave, :reason, :event,
              :grant_proof, :received_at)`,
          {
            ...reject,
            event: JSON.stringify(reject.event),
            grant_proof: JSON.stringify(reject.grant_proof)
          },
          opts
        );
      }
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
             (event_id, relay_id, wave, wave_key, drop_id, kind, author,
              device_key, auth_ref, seq, claimed_time, event, grant_proof,
              origin, event_origin, status, status_reason, grant_check,
              grant_revoked_at, received_at)
           values (:event_id, :relay_id, :wave, :wave_key, :drop_id, :kind,
              :author, :device_key, :auth_ref, :seq, :claimed_time, :event,
              :grant_proof, :origin, :event_origin, :status, :status_reason,
              :grant_check, :grant_revoked_at, :received_at)`,
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
   * author also sent them to 6529.io): marked `site`, with their drop. Also
   * fills the drop of a site event read while 6529.io's write of it was
   * under way, so every POST row ends up naming its drop.
   */
  async markSiteWritten(): Promise<number> {
    const result = await this.db.execute(
      `update ${WAVE_RELAY_EVENTS_TABLE} e
         join ${DEVICE_SIGNED_EVENTS_TABLE} d on d.id = e.event_id
          set e.origin = 'site', e.drop_id = d.drop_id
        where ((e.origin = 'relay' and e.status = 'logged')
            or (e.origin = 'site' and e.drop_id is null))
          and d.drop_id is not null`
    );
    return this.db.getAffectedRows(result);
  }

  /** Relay-only events not written into 6529.io's tables yet, in order. */
  async pendingRelayEvents(
    limit: number,
    now: number
  ): Promise<IngestedEvent[]> {
    // Due events only, at most PENDING_PER_AUTHOR of one author's, and none
    // of a drop that has an earlier event still waiting. Half the batch is
    // kept for events never tried, so wallets whose events keep waiting
    // can't fill it together. A drop's events stay in order: a never-tried
    // event comes only when no earlier event of its drop is pending.
    const fresh = await this.duePending(Math.ceil(limit / 2), now, true);
    const rows = new Map(fresh.map((row) => [Number(row.ingest_seq), row]));
    for (const row of await this.duePending(limit, now, false)) {
      if (rows.size >= limit) break;
      rows.set(Number(row.ingest_seq), row);
    }
    return Array.from(rows.values())
      .sort((a, b) => Number(a.ingest_seq) - Number(b.ingest_seq))
      .map(toIngested);
  }

  private async duePending(
    limit: number,
    now: number,
    neverTried: boolean
  ): Promise<StoredRow[]> {
    return this.db.execute<StoredRow>(
      `select * from (
          select e.*, row_number() over (
                   partition by e.author order by e.ingest_seq) as author_rank
            from ${WAVE_RELAY_EVENTS_TABLE} e
           where e.origin = 'relay' and e.status = 'logged'
             and (e.next_try_at is null or e.next_try_at <= :now)
             ${
               neverTried
                 ? `and e.status_reason is null and e.apply_attempts = 0
                    and e.next_try_at is null`
                 : ''
             }
             and not exists (
               select 1 from ${WAVE_RELAY_EVENTS_TABLE} w
                where w.drop_id = e.drop_id and w.ingest_seq < e.ingest_seq
                  and w.origin = 'relay' and w.status = 'logged'
                  and ${neverTried ? 'true' : 'w.next_try_at > :now'})
        ) due
        where author_rank <= :perAuthor
        order by ingest_seq limit :limit`,
      { limit, now, perAuthor: PENDING_PER_AUTHOR }
    );
  }

  /**
   * Whether the index holds a checked delete of this drop by its author's
   * wallet: only the author's own key, under a grant of theirs, deletes a
   * post before it is written.
   */
  async hasTombstone(dropId: string, author: string): Promise<boolean> {
    const row = await this.db.oneOrNull<{ found: number }>(
      `select 1 as found from ${WAVE_RELAY_EVENTS_TABLE}
        where drop_id = :dropId and kind = :kind and author = :author
          and status in ('logged', 'applied')
        limit 1`,
      { dropId, kind: DeviceEventKind.TOMBSTONE, author: author.toLowerCase() }
    );
    return row !== null;
  }

  /**
   * Whether 6529.io holds an unfinished reservation of this event (an
   * earlier try reserved it and stopped before writing).
   */
  async hasPendingReservation(eventId: string): Promise<boolean> {
    const row = await this.db.oneOrNull<{ found: number }>(
      `select 1 as found from ${DEVICE_SIGNED_EVENTS_TABLE}
        where id = :eventId and drop_id is null limit 1`,
      { eventId }
    );
    return row !== null;
  }

  /**
   * Whether the 6529 chain holds the wave of an event first seen at
   * `seenAt`, by the chain index's mapping (waves-chain-mapping.ts), read on
   * the writer:
   * - `direct_message`: a direct message on 6529.io, which stays always;
   * - `unknown`: the index hasn't finished a full read of the chain (on its
   *   network, WAVES_SETTLEMENT_NETWORK_ID, when that is set);
   * - `moved`: the chain holds it, and 6529.io has its row;
   * - `not_on_site`: the chain holds it, and the chain mirror hasn't
   *   written its row on 6529.io yet;
   * - `behind`: it doesn't, but the index hasn't read the chain through
   *   `seenAt` yet, so the wave may be one made on the chain since;
   * - `stays`: the index has read past `seenAt` and the chain doesn't hold
   *   it.
   */
  async waveOnChain(wave: string, seenAt: number): Promise<WaveOnChain> {
    const id = wave.trim().toLowerCase();
    const options = { forcePool: DbPoolName.WRITE };
    const site = await this.db.oneOrNull<{ dm: number | string | null }>(
      `select coalesce(is_direct_message, 0) as dm from ${WAVES_TABLE}
        where id = :id`,
      { id },
      options
    );
    if (Number(site?.dm ?? 0) === 1) return 'direct_message';
    const progress = await chainIndexProgress(
      this.db,
      options,
      expectedChainNetwork()
    );
    if (!progress.ready) return 'unknown';
    if ((await wavesOnChain(this.db, [id], options)).has(id)) {
      return site ? 'moved' : 'not_on_site';
    }
    return progress.readThrough !== null && progress.readThrough >= seenAt
      ? 'stays'
      : 'behind';
  }

  /** Copies that failed a check, after `id` (a fix checks them again). */
  async rejectsAfter(
    id: number,
    limit: number
  ): Promise<(RejectRow & { id: number })[]> {
    const rows = await this.db.execute<
      RejectRow & {
        id: number | string;
        event: string | Record<string, unknown>;
        grant_proof: string | Record<string, unknown>;
      }
    >(
      `select * from ${WAVE_RELAY_REJECTS_TABLE}
        where id > :id order by id limit :limit`,
      { id, limit }
    );
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      received_at: Number(row.received_at),
      event: json(row.event),
      grant_proof: json(row.grant_proof)
    }));
  }

  /**
   * Drops a reservation of this event that an earlier try left (a signed
   * write reserves the event, then the run stopped before the write),
   * when it is older than STALE_RESERVATION_MS.
   */
  async releaseStaleReservation(eventId: string): Promise<void> {
    await this.db.execute(
      `delete from ${DEVICE_SIGNED_EVENTS_TABLE}
        where id = :eventId and drop_id is null and created_at < :before`,
      { eventId, before: Date.now() - STALE_RESERVATION_MS }
    );
  }

  /** Records what writing an event into 6529.io's tables came to. */
  async markApplied(
    ingestSeq: number,
    status: 'applied' | 'refused' | 'failed' | 'logged' | 'waiting',
    reason: string | null,
    dropId: string | null,
    nextTryAt: number | null = null
  ): Promise<void> {
    // 'waiting' stays pending (as 'logged') without counting a try, and is
    // not tried again before nextTryAt.
    await this.db.execute(
      `update ${WAVE_RELAY_EVENTS_TABLE}
          set status = :stored, status_reason = :reason,
              drop_id = coalesce(:dropId, drop_id),
              apply_attempts = apply_attempts
                + if(:status in ('applied', 'waiting'), 0, 1),
              next_try_at = :nextTryAt
        where ingest_seq = :ingestSeq`,
      {
        ingestSeq,
        status,
        stored: status === 'waiting' ? 'logged' : status,
        reason: reason?.slice(0, 255) ?? null,
        dropId,
        nextTryAt: status === 'waiting' ? nextTryAt : null
      }
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
