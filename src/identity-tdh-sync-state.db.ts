import { randomUUID } from 'node:crypto';
import { IDENTITY_TDH_SYNC_STATE_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { identityTdhSyncScopeDb } from '@/identity-tdh-sync-scope.db';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

const PENDING = 'pending';
const SYNCED = 'synced';
const LEASE = 'lease';
const METRICS_WALK = 'metrics_walk';
const FULL_ANNOUNCE = 'full_announce';
const FULL_WALK = 'full_walk';
const ROW_IDS = [
  PENDING,
  SYNCED,
  LEASE,
  METRICS_WALK,
  FULL_ANNOUNCE,
  FULL_WALK
];

/**
 * The rows are never deleted, so the pending generation only grows and the
 * synced generation never passes it. "Synced" means a full B to E run started
 * after that generation's TDH write committed.
 */
export interface IdentityTdhSyncProgress {
  /** Bumped by every committed consolidated-TDH transaction. */
  readonly pendingGeneration: number;
  readonly pendingBlock: number;
  /** The highest pending generation whose identities sync finished. */
  readonly syncedGeneration: number;
}

/**
 * Rows of identity_tdh_sync_state (see IIdentityTdhSyncState.ts). Reads use
 * the writer pool: a replica could still show a generation as pending after
 * it was synced, or miss one that was just committed.
 */
export class IdentityTdhSyncStateDb extends LazyDbAccessCompatibleService {
  /**
   * Creates the fixed rows on first use. Checks first without locking, so the
   * usual call never waits on a TDH transaction holding the pending row.
   */
  async ensureRows(): Promise<void> {
    const rows = await this.db.execute<{ id: string }>(
      `select id from ${IDENTITY_TDH_SYNC_STATE_TABLE} where id in (:ids)`,
      { ids: ROW_IDS },
      { forcePool: DbPoolName.WRITE }
    );
    if (rows.length === ROW_IDS.length) return;
    await this.db.execute(
      `insert ignore into ${IDENTITY_TDH_SYNC_STATE_TABLE}
         (id, generation, block, lease_owner, lease_until, updated_at)
       values ('${PENDING}', 0, 0, null, 0, 0),
              ('${SYNCED}', 0, 0, null, 0, 0),
              ('${LEASE}', 0, 0, null, 0, 0),
              ('${METRICS_WALK}', 0, 0, null, 0, 0),
              ('${FULL_ANNOUNCE}', 0, 0, null, 0, 0),
              ('${FULL_WALK}', 0, 0, null, 0, 0)`
    );
  }

  /**
   * Inside the consolidated-TDH transaction: once it commits, the identities
   * sync for this generation is pending until `markSynced`. A full TDH write
   * also arms its "TDH calculations done" announcement, which the sync
   * publishes once identities reflect it (`claimFullAnnouncement`).
   */
  async markPending(
    block: number,
    connection: ConnectionWrapper<any>,
    { announceFull = false }: { announceFull?: boolean } = {}
  ): Promise<number> {
    const now = Time.currentMillis();
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set generation = generation + 1, block = :block, updated_at = :now
       where id = '${PENDING}'`,
      { block, now },
      { wrappedConnection: connection }
    );
    const row = await this.db.oneOrNull<{ generation: number | string }>(
      `select generation from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${PENDING}'`,
      undefined,
      { wrappedConnection: connection }
    );
    const generation = Number(row?.generation ?? 0);
    if (announceFull) {
      await this.db.execute(
        `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
         set generation = :generation, block = :block, updated_at = :now
         where id = '${FULL_ANNOUNCE}'`,
        { generation, block, now },
        { wrappedConnection: connection }
      );
    }
    return generation;
  }

  async readProgress(): Promise<IdentityTdhSyncProgress> {
    const rows = await this.db.execute<{
      id: string;
      generation: number | string;
      block: number | string;
    }>(
      `select id, generation, block from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id in ('${PENDING}', '${SYNCED}')`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    const pending = rows.find((row) => row.id === PENDING);
    const synced = rows.find((row) => row.id === SYNCED);
    return {
      pendingGeneration: Number(pending?.generation ?? 0),
      pendingBlock: Number(pending?.block ?? 0),
      syncedGeneration: Number(synced?.generation ?? 0)
    };
  }

  /**
   * Step C's walk: the generation it belongs to and the key it resumes after.
   * It is started only once B committed for that generation, so a walk of the
   * pending generation also means B is done for it.
   */
  async readMetricsWalk(): Promise<{ generation: number; after: string }> {
    const row = await this.db.oneOrNull<{
      generation: number | string;
      walk_after: string | null;
    }>(
      `select generation, walk_after from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${METRICS_WALK}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return {
      generation: Number(row?.generation ?? 0),
      after: row?.walk_after ?? ''
    };
  }

  /**
   * After B committed: step C for `generation` walks from the first key. The
   * walk also records the ratings watermark it establishes once synced: the
   * database's clock now, less `ratingsMarginSeconds`.
   */
  async startMetricsWalk(
    generation: number,
    ratingsMarginSeconds: number
  ): Promise<void> {
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set generation = :generation, walk_after = '',
           ratings_since = greatest(unix_timestamp() - :ratingsMarginSeconds, 1),
           updated_at = :now
       where id = '${METRICS_WALK}'`,
      { generation, ratingsMarginSeconds, now: Time.currentMillis() }
    );
  }

  /** The ratings watermark the current walk establishes once synced. */
  async readWalkRatingsSince(): Promise<number> {
    const row = await this.db.oneOrNull<{ ratings_since: number | string }>(
      `select ratings_since from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${METRICS_WALK}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return Number(row?.ratings_since ?? 0);
  }

  /**
   * Ratings modified at or after this time (database clock, epoch seconds)
   * may not be reflected in identities yet; 0 when no sync has set it.
   */
  async readSyncedRatingsSince(): Promise<number> {
    const row = await this.db.oneOrNull<{ ratings_since: number | string }>(
      `select ratings_since from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${SYNCED}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return Number(row?.ratings_since ?? 0);
  }

  /** When step C last walked every identity (epoch ms), 0 if never. */
  async readLastFullWalkAt(): Promise<number> {
    const row = await this.db.oneOrNull<{ updated_at: number | string }>(
      `select updated_at from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${FULL_WALK}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return Number(row?.updated_at ?? 0);
  }

  /** In the chunk's transaction: the walk resumes after this chunk. */
  async advanceMetricsWalk(
    generation: number,
    after: string,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set walk_after = :after, updated_at = :now
       where id = '${METRICS_WALK}' and generation = :generation`,
      { generation, after, now: Time.currentMillis() },
      { wrappedConnection: connection }
    );
  }

  /**
   * True for exactly one caller once a full TDH write's generation is synced:
   * that caller publishes the announcement. The claim token is kept in the
   * row's lease_owner column, so the read-back shows who won.
   */
  async claimFullAnnouncement(syncedGeneration: number): Promise<boolean> {
    const token = randomUUID();
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set generation = 0, lease_owner = :token, updated_at = :now
       where id = '${FULL_ANNOUNCE}' and generation > 0
         and generation <= :syncedGeneration`,
      { token, syncedGeneration, now: Time.currentMillis() }
    );
    const row = await this.db.oneOrNull<{ lease_owner: string | null }>(
      `select lease_owner from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${FULL_ANNOUNCE}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return row?.lease_owner === token;
  }

  /** Puts a claimed announcement back when publishing it failed. */
  async rearmFullAnnouncement(generation: number): Promise<void> {
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set generation = greatest(generation, :generation), updated_at = :now
       where id = '${FULL_ANNOUNCE}'`,
      { generation, now: Time.currentMillis() }
    );
  }

  /** A full TDH write is waiting for its identities sync to be announced. */
  async hasPendingFullAnnouncement(): Promise<boolean> {
    const row = await this.db.oneOrNull<{ generation: number | string }>(
      `select generation from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${FULL_ANNOUNCE}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return Number(row?.generation ?? 0) > 0;
  }

  /**
   * Raises the synced generation (never lowers it) with the ratings watermark
   * its walk established, records a full walk, and drops the scope rows the
   * synced generations no longer need, in one transaction.
   */
  async markSynced({
    generation,
    block,
    ratingsSince,
    fullWalk
  }: {
    generation: number;
    block: number;
    ratingsSince: number;
    fullWalk: boolean;
  }): Promise<void> {
    const now = Time.currentMillis();
    await this.executeNativeQueriesInTransaction(async (connection) => {
      await this.db.execute(
        `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
         set generation = :generation, block = :block,
             ratings_since = :ratingsSince, updated_at = :now
         where id = '${SYNCED}' and generation < :generation`,
        { generation, block, ratingsSince, now },
        { wrappedConnection: connection }
      );
      if (fullWalk) {
        await this.db.execute(
          `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
           set generation = :generation, block = :block, updated_at = :now
           where id = '${FULL_WALK}'`,
          { generation, block, now },
          { wrappedConnection: connection }
        );
      }
      await identityTdhSyncScopeDb.deleteThrough(generation, connection);
    });
  }

  /**
   * One sync at a time across delegationsLoop invocations. True when `owner`
   * holds the lease after the call. An expired lease (an invocation that was
   * killed) can be taken over.
   */
  async acquireLease(owner: string, ttlMs: number): Promise<boolean> {
    const now = Time.currentMillis();
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set lease_owner = :owner, lease_until = :until, updated_at = :now
       where id = '${LEASE}' and (lease_until < :now or lease_owner = :owner)`,
      { owner, until: now + ttlMs, now }
    );
    const row = await this.db.oneOrNull<{ lease_owner: string | null }>(
      `select lease_owner from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id = '${LEASE}'`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return row?.lease_owner === owner;
  }

  async releaseLease(owner: string): Promise<void> {
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set lease_owner = null, lease_until = 0, updated_at = :now
       where id = '${LEASE}' and lease_owner = :owner`,
      { owner, now: Time.currentMillis() }
    );
  }
}

export const identityTdhSyncStateDb = new IdentityTdhSyncStateDb(dbSupplier);
