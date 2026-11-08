import { IDENTITY_TDH_SYNC_STATE_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

const PENDING = 'pending';
const SYNCED = 'synced';
const LEASE = 'lease';
const ROW_IDS = [PENDING, SYNCED, LEASE];

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
              ('${LEASE}', 0, 0, null, 0, 0)`
    );
  }

  /**
   * Inside the consolidated-TDH transaction: once it commits, the identities
   * sync for this generation is pending until `markSynced`.
   */
  async markPending(
    block: number,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set generation = generation + 1, block = :block, updated_at = :now
       where id = '${PENDING}'`,
      { block, now: Time.currentMillis() },
      { wrappedConnection: connection }
    );
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

  /** Raises the synced generation; never lowers it. */
  async markSynced(generation: number, block: number): Promise<void> {
    await this.db.execute(
      `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
       set generation = :generation, block = :block, updated_at = :now
       where id = '${SYNCED}' and generation < :generation`,
      { generation, block, now: Time.currentMillis() }
    );
  }

  /**
   * One sync at a time across delegationsLoop and tdhLoop. True when `owner`
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
