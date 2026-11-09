import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import {
  SQL_IN_LIST_CHUNK_BYTES,
  sqlInListBytes
} from '@/db/sql-in-list-chunks';
import { Logger } from '@/logging';
import { isRetryableDbLockError } from '@/nextgen/nextgen-db-lock-retry';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

const logger = Logger.get('IDENTITY_METRICS_SYNC');

/**
 * Rows per chunk. The chunk's profile ids are inlined once per statement, and
 * the list is also capped at SQL_IN_LIST_CHUNK_BYTES so every statement stays
 * under the RDS Proxy 16 KB pin threshold: 300 UUIDs fill that budget.
 */
const IDENTITY_METRICS_SYNC_CHUNK_ROWS = 300;
const IDENTITY_METRICS_SYNC_PROFILE_ID_BYTES = SQL_IN_LIST_CHUNK_BYTES;
/** ratings (matter, matter_target_id, rater_profile_id, rating): covering. */
const RATINGS_SUM_INDEX = 'idx_ratings_2';
const CHUNK_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 200;

type ChunkRow = {
  readonly consolidation_key: string;
  readonly profile_id: string | null;
};

type Chunk = {
  /** Exclusive lower bound: the previous chunk's last key. */
  readonly after: string;
  /** Inclusive upper bound. */
  readonly last: string;
  readonly rows: ChunkRow[];
  readonly profileIds: string[];
};

export type IdentityMetricsSyncOptions = {
  readonly chunkRows?: number;
  readonly profileIdBytes?: number;
  /** Resume after this key (a previous run's last committed chunk). */
  readonly startAfter?: string;
  /** Runs inside each chunk's transaction, with its last key. */
  readonly recordProgress?: (
    last: string,
    connection: ConnectionWrapper<any>
  ) => Promise<void>;
  /** Test hook: runs after each committed chunk (1-based). */
  readonly afterChunk?: (chunk: number) => Promise<void> | void;
  /** Test hook: runs inside a chunk once its source rows are locked. */
  readonly afterSourcesLocked?: (chunk: number) => Promise<void> | void;
};

type ChunkSettings = {
  readonly chunkRows: number;
  readonly profileIdBytes: number;
  readonly recordProgress?: IdentityMetricsSyncOptions['recordProgress'];
  readonly afterSourcesLocked?: (chunk: number) => Promise<void> | void;
};

export type IdentityMetricsSyncResult = {
  readonly chunks: number;
  readonly rows: number;
  readonly retries: number;
  /** The longest chunk, retries included. */
  readonly slowestChunkMs: number;
};

/** The chunk's rows changed between reading its ids and locking them. */
class IdentityChunkChangedError extends Error {
  constructor() {
    super('Identity chunk changed while it was synced');
    this.name = 'IdentityChunkChangedError';
    // The ES5 build target otherwise breaks instanceof on Error subclasses.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A deadlock or lock wait timeout (also wrapped by TypeORM), or a changed chunk. */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof IdentityChunkChangedError || isRetryableDbLockError(error)
  );
}

function sameRows(expected: ChunkRow[], actual: ChunkRow[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (row, i) =>
        row.consolidation_key === actual[i].consolidation_key &&
        row.profile_id === actual[i].profile_id
    )
  );
}

/**
 * Recomputes identities.rep, cic, tdh, basetdh_rate and level_raw from their
 * sources (REP and CIC ratings, consolidated TDH), the same values the old
 * all-rows reset and recompute produced, without a long transaction.
 *
 * Identities are walked in primary-key order. Each chunk is one short
 * transaction that writes every row's final values at once, so no reader ever
 * sees a reset or partial value: an interrupted run leaves each row at its old
 * or its final values, and re-running converges. Rows already correct are not
 * written.
 *
 * Lock order (the rule for every transaction writing ratings and identities):
 * ratings row locks before identities row locks, identities in key order.
 * The rating path updates ratings, then applies its delta to identities. A
 * chunk first takes shared locks on the consolidated TDH rows and on the
 * ratings of its profiles, then updates its identities, so it never holds an
 * identities lock while waiting for a ratings lock. A rating in flight makes
 * the chunk wait, then the chunk sums it; a rating arriving during the chunk
 * waits on the chunk's ratings locks, then adds its delta to the recomputed
 * value. Either order ends at sum(ratings).
 */
export class IdentityMetricsSync extends LazyDbAccessCompatibleService {
  public async syncAll(
    options: IdentityMetricsSyncOptions = {}
  ): Promise<IdentityMetricsSyncResult> {
    const settings: ChunkSettings = {
      chunkRows: options.chunkRows ?? IDENTITY_METRICS_SYNC_CHUNK_ROWS,
      profileIdBytes:
        options.profileIdBytes ?? IDENTITY_METRICS_SYNC_PROFILE_ID_BYTES,
      afterSourcesLocked: options.afterSourcesLocked,
      recordProgress: options.recordProgress
    };
    const start = Time.now();
    let after = options.startAfter ?? '';
    let chunks = 0;
    let rows = 0;
    let retries = 0;
    let slowestChunkMs = 0;
    for (;;) {
      const chunkStart = Time.now();
      const synced = await this.syncChunkWithRetries(
        after,
        chunks + 1,
        settings
      );
      retries += synced.retries;
      if (!synced.chunk) break;
      slowestChunkMs = Math.max(
        slowestChunkMs,
        chunkStart.diffFromNow().toMillis()
      );
      chunks++;
      rows += synced.chunk.rows.length;
      after = synced.chunk.last;
      await options.afterChunk?.(chunks);
    }
    logger.info(
      `[SYNCED ${rows} IDENTITIES IN ${chunks} CHUNKS] [RETRIES ${retries}] [SLOWEST CHUNK ${slowestChunkMs} ms] [${start.diffFromNow()}]`
    );
    return { chunks, rows, retries, slowestChunkMs };
  }

  private async syncChunkWithRetries(
    after: string,
    chunkNumber: number,
    settings: ChunkSettings
  ): Promise<{ chunk: Chunk | null; retries: number }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const chunk = await this.executeNativeQueriesInTransaction(
          (connection) =>
            this.syncChunk(after, chunkNumber, settings, connection)
        );
        return { chunk, retries: attempt - 1 };
      } catch (error) {
        if (!isRetryable(error) || attempt >= CHUNK_ATTEMPTS) throw error;
        logger.warn(
          `[CHUNK AFTER ${after} RETRY ${attempt}] ${(error as Error).message}`
        );
        await Time.millis(RETRY_BASE_DELAY_MS * attempt).sleep();
      }
    }
  }

  private async syncChunk(
    after: string,
    chunkNumber: number,
    settings: ChunkSettings,
    connection: ConnectionWrapper<any>
  ): Promise<Chunk | null> {
    const chunk = await this.readChunk(after, settings, connection);
    if (!chunk) return null;
    const range = { after: chunk.after, last: chunk.last };
    // 1. Shared locks on the sources, before any identities lock.
    await this.db.execute(
      `select count(*) as n from ${CONSOLIDATED_WALLETS_TDH_TABLE}
       where consolidation_key > :after and consolidation_key <= :last
       for share`,
      range,
      { wrappedConnection: connection }
    );
    // `in (NULL)` matches nothing: a chunk without profiles has no ratings.
    // This read and the UPDATE below use the same index, so the UPDATE reads
    // only ratings index records this chunk already holds: a rating write
    // that has changed another index and waits on this one can't block it.
    const profileIds = chunk.profileIds.length ? chunk.profileIds : [null];
    await this.db.execute(
      `select count(*) as n from ${RATINGS_TABLE} force index (${RATINGS_SUM_INDEX})
       where matter in ('REP', 'CIC') and matter_target_id in (:profileIds)
       for share`,
      { profileIds },
      { wrappedConnection: connection }
    );
    await settings.afterSourcesLocked?.(chunkNumber);
    // 2. Final values for every row of the chunk, written only where they
    // differ. level_raw is written from the new values explicitly: a
    // multi-table UPDATE does not promise left-to-right assignment.
    await this.db.execute(
      `update ${IDENTITIES_TABLE} i
       left join (
         select matter_target_id as profile_id,
                sum(case when matter = 'REP' then rating else 0 end) as rep,
                sum(case when matter = 'CIC' then rating else 0 end) as cic
         from ${RATINGS_TABLE} force index (${RATINGS_SUM_INDEX})
         where matter in ('REP', 'CIC') and matter_target_id in (:profileIds)
         group by matter_target_id
       ) r on r.profile_id = i.profile_id
       left join ${CONSOLIDATED_WALLETS_TDH_TABLE} c
         on c.consolidation_key = i.consolidation_key
       set i.rep = coalesce(r.rep, 0),
           i.cic = coalesce(r.cic, 0),
           i.tdh = coalesce(c.boosted_tdh, 0),
           i.basetdh_rate = coalesce(c.boosted_tdh_rate, 0),
           i.level_raw = coalesce(r.rep, 0) + coalesce(c.boosted_tdh, 0) + i.xtdh
       where i.consolidation_key > :after and i.consolidation_key <= :last
         and (i.rep <> coalesce(r.rep, 0)
           or i.cic <> coalesce(r.cic, 0)
           or i.tdh <> coalesce(c.boosted_tdh, 0)
           or i.basetdh_rate <> coalesce(c.boosted_tdh_rate, 0)
           or i.level_raw <> coalesce(r.rep, 0) + coalesce(c.boosted_tdh, 0) + i.xtdh)`,
      { ...range, profileIds },
      { wrappedConnection: connection }
    );
    // 3. The UPDATE locked the whole key range. If its rows are not the ones
    // read in step 0 (a row was added or removed, or a profile id changed),
    // some row may have been summed against the wrong ratings: roll back
    // and redo the chunk.
    const locked = await this.db.execute<ChunkRow>(
      `select consolidation_key, profile_id from ${IDENTITIES_TABLE}
       where consolidation_key > :after and consolidation_key <= :last
       order by consolidation_key asc
       for share`,
      range,
      { wrappedConnection: connection }
    );
    if (!sameRows(chunk.rows, locked)) throw new IdentityChunkChangedError();
    // Commits with the chunk, so a resumed walk never skips or redoes it.
    await settings.recordProgress?.(chunk.last, connection);
    return chunk;
  }

  /** Step 0: the next chunk's keys and profile ids, without locking. */
  private async readChunk(
    after: string,
    { chunkRows, profileIdBytes }: ChunkSettings,
    connection: ConnectionWrapper<any>
  ): Promise<Chunk | null> {
    const candidates = await this.db.execute<ChunkRow>(
      `select consolidation_key, profile_id from ${IDENTITIES_TABLE}
       where consolidation_key > :after
       order by consolidation_key asc
       limit :limit`,
      { after, limit: chunkRows },
      { wrappedConnection: connection }
    );
    if (!candidates.length) return null;
    const rows: ChunkRow[] = [];
    const profileIds = new Set<string>();
    let bytes = 0;
    for (const row of candidates) {
      const profileId = row.profile_id;
      if (profileId !== null && !profileIds.has(profileId)) {
        // As inlined by the driver: escaped values joined by ", ".
        const added = sqlInListBytes([profileId]) + (profileIds.size ? 2 : 0);
        if (rows.length && bytes + added > profileIdBytes) break;
        bytes += added;
        profileIds.add(profileId);
      }
      rows.push(row);
    }
    return {
      after,
      last: rows[rows.length - 1].consolidation_key,
      rows,
      profileIds: Array.from(profileIds)
    };
  }
}

export const identityMetricsSync = new IdentityMetricsSync(dbSupplier);
