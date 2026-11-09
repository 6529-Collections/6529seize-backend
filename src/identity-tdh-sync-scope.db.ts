import { collections } from '@/collections';
import { IDENTITY_TDH_SYNC_SCOPE_TABLE, RATINGS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RateMatter } from '@/entities/IRating';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

/** See IIdentityTdhSyncScope.ts. */
export enum IdentityTdhSyncScopeKind {
  SCOPE_RECORDED = 'SCOPE_RECORDED',
  CONSOLIDATION_KEY = 'CONSOLIDATION_KEY',
  PROFILE = 'PROFILE'
}

export interface IdentityTdhSyncScope {
  readonly consolidationKeys: string[];
  readonly profileIds: string[];
}

/**
 * Rows per insert. A consolidation key is at most a few addresses, so a
 * statement stays well under the RDS Proxy 16 KB pin threshold.
 */
const INSERT_CHUNK_ROWS = 50;

/**
 * The identities each consolidated-TDH generation changed (table
 * identity_tdh_sync_scope). Reads use the writer pool, like the sync state:
 * a replica could miss rows of a generation that was just committed.
 */
export class IdentityTdhSyncScopeDb extends LazyDbAccessCompatibleService {
  /**
   * Inside a partial TDH write's transaction (step A): the keys whose
   * consolidated TDH rows it replaced or wrote, and the mark that this
   * generation's scope is complete.
   */
  async recordTdhWrite(
    generation: number,
    consolidationKeys: string[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.insert(
      generation,
      [
        { kind: IdentityTdhSyncScopeKind.SCOPE_RECORDED, value: '' },
        ...collections.distinct(consolidationKeys).map((value) => ({
          kind: IdentityTdhSyncScopeKind.CONSOLIDATION_KEY,
          value
        }))
      ],
      connection
    );
  }

  /** Inside step B's transaction: the identities and profiles it wrote. */
  async recordIdentitiesWritten(
    generation: number,
    { consolidationKeys, profileIds }: IdentityTdhSyncScope,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.insert(
      generation,
      [
        ...collections.distinct(consolidationKeys).map((value) => ({
          kind: IdentityTdhSyncScopeKind.CONSOLIDATION_KEY,
          value
        })),
        ...collections.distinct(profileIds).map((value) => ({
          kind: IdentityTdhSyncScopeKind.PROFILE,
          value
        }))
      ],
      connection
    );
  }

  /** How many generations in (after, through] recorded their scope. */
  async countRecordedGenerations(
    after: number,
    through: number
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ n: number | string }>(
      `select count(distinct generation) as n from ${IDENTITY_TDH_SYNC_SCOPE_TABLE}
       where generation > :after and generation <= :through
         and kind = '${IdentityTdhSyncScopeKind.SCOPE_RECORDED}'`,
      { after, through },
      { forcePool: DbPoolName.WRITE }
    );
    return Number(row?.n ?? 0);
  }

  /** The keys and profiles generations (after, through] changed. */
  async readScope(
    after: number,
    through: number
  ): Promise<IdentityTdhSyncScope> {
    const rows = await this.db.execute<{ kind: string; value: string }>(
      `select distinct kind, value from ${IDENTITY_TDH_SYNC_SCOPE_TABLE}
       where generation > :after and generation <= :through
         and kind in ('${IdentityTdhSyncScopeKind.CONSOLIDATION_KEY}', '${IdentityTdhSyncScopeKind.PROFILE}')`,
      { after, through },
      { forcePool: DbPoolName.WRITE }
    );
    const valuesOf = (kind: IdentityTdhSyncScopeKind) =>
      rows.filter((row) => row.kind === kind).map((row) => row.value);
    return {
      consolidationKeys: valuesOf(IdentityTdhSyncScopeKind.CONSOLIDATION_KEY),
      profileIds: valuesOf(IdentityTdhSyncScopeKind.PROFILE)
    };
  }

  /**
   * Profiles whose REP or CIC ratings were written at or after `since`
   * (database clock, epoch seconds). Every ratings writer sets
   * `last_modified` to the database's time in the statement that changes the
   * rating. A plain scan: `distinct` here makes MySQL walk an index and look
   * up every row (6 s against 0.9 s on the prod reader for 1.5M ratings).
   */
  async findRatedProfilesSince(since: number): Promise<string[]> {
    const rows = await this.db.execute<{ matter_target_id: string }>(
      `select matter_target_id from ${RATINGS_TABLE}
       where matter in ('${RateMatter.REP}', '${RateMatter.CIC}')
         and last_modified >= from_unixtime(:since)`,
      { since },
      { forcePool: DbPoolName.WRITE }
    );
    return collections.distinct(rows.map((row) => row.matter_target_id));
  }

  /** Once `generation` is synced: its rows and older ones are not needed. */
  async deleteThrough(
    generation: number,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `delete from ${IDENTITY_TDH_SYNC_SCOPE_TABLE} where generation <= :generation`,
      { generation },
      { wrappedConnection: connection }
    );
  }

  private async insert(
    generation: number,
    rows: { kind: IdentityTdhSyncScopeKind; value: string }[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.bulkInsert(
      IDENTITY_TDH_SYNC_SCOPE_TABLE,
      rows.map((row) => ({ generation, ...row })),
      ['generation', 'kind', 'value'],
      undefined,
      { connection, ignoreDuplicates: true, chunkSize: INSERT_CHUNK_ROWS }
    );
  }
}

export const identityTdhSyncScopeDb = new IdentityTdhSyncScopeDb(dbSupplier);
