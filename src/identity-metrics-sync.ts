import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import {
  querySqlInListChunks,
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
 * under the RDS Proxy 16 KB pin threshold: 300 UUIDs fill that budget. A
 * scoped chunk also inlines its keys, and both lists share the budget.
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

/**
 * The identities a chunk covers: a primary-key range of the full walk, or the
 * listed keys of a scoped sync.
 */
type ChunkSelector =
  | {
      readonly kind: 'RANGE';
      /** Exclusive lower bound: the previous chunk's last key. */
      readonly after: string;
      /** Inclusive upper bound. */
      readonly last: string;
    }
  | { readonly kind: 'KEYS'; readonly keys: string[] };

type Chunk = {
  readonly selector: ChunkSelector;
  /** The chunk's last key: where the full walk continues. */
  readonly last: string;
  readonly rows: ChunkRow[];
  readonly profileIds: string[];
};

type SyncedChunk = { readonly chunk: Chunk; readonly updated: number };

type ChunkReader = (
  connection: ConnectionWrapper<any>
) => Promise<Chunk | null>;

type ChunkHooks = {
  /**
   * Checked before each chunk: true stops the walk cleanly, between chunks,
   * and the result reports it incomplete (a time budget).
   */
  readonly shouldStop?: () => boolean;
  /** Test hook: runs after each committed chunk (1-based). */
  readonly afterChunk?: (chunk: number) => Promise<void> | void;
  /** Test hook: runs inside a chunk once its source rows are locked. */
  readonly afterSourcesLocked?: (chunk: number) => Promise<void> | void;
};

export type IdentityMetricsSyncOptions = ChunkHooks & {
  readonly chunkRows?: number;
  readonly profileIdBytes?: number;
  /** Resume after this key (a previous run's last committed chunk). */
  readonly startAfter?: string;
  /** Runs inside each chunk's transaction, with its last key. */
  readonly recordProgress?: (
    last: string,
    connection: ConnectionWrapper<any>
  ) => Promise<void>;
};

export type IdentityMetricsScopedSyncOptions = ChunkHooks & {
  readonly chunkRows?: number;
  readonly profileIdBytes?: number;
  /** Identities with these keys... */
  readonly consolidationKeys: string[];
  /** ...and the identities of these profiles. */
  readonly profileIds: string[];
};

type ChunkSettings = {
  readonly profileIdBytes: number;
  readonly recordProgress?: IdentityMetricsSyncOptions['recordProgress'];
  readonly afterSourcesLocked?: (chunk: number) => Promise<void> | void;
};

export type IdentityMetricsSyncResult = {
  /** False when `shouldStop` ended the walk before the last identity. */
  readonly complete: boolean;
  readonly chunks: number;
  readonly rows: number;
  /** Rows whose stored values changed. */
  readonly updated: number;
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

const CHANGED_ROWS = /Changed: (\d+)/;

/**
 * Rows an UPDATE changed, for the logs. Not its affected rows: the driver
 * reports matched rows there, and a row with fractional TDH or xTDH always
 * matches the comparison with its bigint columns while its stored values do
 * not change. The executor returns the OK packet's values, whose info message
 * reads "(Rows matched: n  Changed: m  Warnings: w".
 */
function changedRowsOf(result: unknown): number {
  if (result && typeof result === 'object' && 'changedRows' in result) {
    return Number((result as { changedRows: unknown }).changedRows) || 0;
  }
  const values: unknown[] = Array.isArray(result) ? result : [];
  for (const value of values) {
    const changed = typeof value === 'string' ? CHANGED_ROWS.exec(value) : null;
    if (changed) return Number(changed[1]);
  }
  return 0;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The selector's rows as a SQL condition on `column`, with its params. */
function selectorCondition(
  selector: ChunkSelector,
  column: string
): { sql: string; params: Record<string, unknown> } {
  if (selector.kind === 'RANGE') {
    return {
      sql: `${column} > :after and ${column} <= :last`,
      params: { after: selector.after, last: selector.last }
    };
  }
  return { sql: `${column} in (:keys)`, params: { keys: selector.keys } };
}

/** Distinct non-null profile ids of the rows, in row order. */
function profileIdsOf(rows: ChunkRow[]): string[] {
  return Array.from(
    new Set(
      rows
        .map((row) => row.profile_id)
        .filter((profileId): profileId is string => profileId !== null)
    )
  );
}

/**
 * Splits rows (sorted by key) into chunks of at most `chunkRows` rows whose
 * inlined keys and profile ids together fit `bytes`.
 */
function partitionScopedRows(
  rows: ChunkRow[],
  chunkRows: number,
  bytes: number
): string[][] {
  const chunks: string[][] = [];
  let keys: string[] = [];
  let used = 0;
  for (const row of rows) {
    const values = [row.consolidation_key];
    if (row.profile_id !== null) values.push(row.profile_id);
    // Each value is inlined once, with its ", " separator.
    const added = values.reduce(
      (total, value) => total + sqlInListBytes([value]) + 2,
      0
    );
    if (keys.length && (keys.length >= chunkRows || used + added > bytes)) {
      chunks.push(keys);
      keys = [];
      used = 0;
    }
    keys.push(row.consolidation_key);
    used += added;
  }
  if (keys.length) chunks.push(keys);
  return chunks;
}

/**
 * Recomputes identities.rep, cic, tdh, basetdh_rate and level_raw from their
 * sources (REP and CIC ratings, consolidated TDH), the same values the old
 * all-rows reset and recompute produced, without a long transaction.
 *
 * `syncAll` walks every identity in primary-key order; `syncScoped` covers
 * only the listed identities. Each chunk is one short transaction that writes
 * every row's final values at once, so no reader ever sees a reset or
 * partial value: an interrupted run leaves each row at its old or its final
 * values, and re-running converges. Rows already correct are not written.
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
      profileIdBytes:
        options.profileIdBytes ?? IDENTITY_METRICS_SYNC_PROFILE_ID_BYTES,
      afterSourcesLocked: options.afterSourcesLocked,
      recordProgress: options.recordProgress
    };
    const chunkRows = options.chunkRows ?? IDENTITY_METRICS_SYNC_CHUNK_ROWS;
    let after = options.startAfter ?? '';
    return this.runChunks(
      'WALKED',
      options,
      () => (connection) =>
        this.readRangeChunk(after, chunkRows, settings, connection),
      settings,
      (chunk) => {
        after = chunk.last;
        return true;
      }
    );
  }

  /**
   * Only the identities with the given keys or profiles, in key order. There
   * is no checkpoint: a stopped run is redone in full.
   */
  public async syncScoped(
    options: IdentityMetricsScopedSyncOptions
  ): Promise<IdentityMetricsSyncResult> {
    const settings: ChunkSettings = {
      profileIdBytes:
        options.profileIdBytes ?? IDENTITY_METRICS_SYNC_PROFILE_ID_BYTES,
      afterSourcesLocked: options.afterSourcesLocked
    };
    const rows = await this.readScopedRows(
      options.consolidationKeys,
      options.profileIds
    );
    const keyChunks = partitionScopedRows(
      rows,
      options.chunkRows ?? IDENTITY_METRICS_SYNC_CHUNK_ROWS,
      settings.profileIdBytes
    );
    let next = 0;
    return this.runChunks(
      'SCOPED',
      options,
      () => {
        if (next >= keyChunks.length) return null;
        const keys = keyChunks[next];
        return (connection) => this.readKeysChunk(keys, connection);
      },
      settings,
      () => {
        next++;
        return next < keyChunks.length;
      }
    );
  }

  /**
   * Syncs chunks until the reader finds none (or `nextReader` has none, or
   * `advance` says the last one is done), checking `shouldStop` before each.
   */
  private async runChunks(
    label: 'WALKED' | 'SCOPED',
    hooks: ChunkHooks,
    nextReader: () => ChunkReader | null,
    settings: ChunkSettings,
    advance: (chunk: Chunk) => boolean
  ): Promise<IdentityMetricsSyncResult> {
    const start = Time.now();
    let chunks = 0;
    let rows = 0;
    let updated = 0;
    let retries = 0;
    let slowestChunkMs = 0;
    let complete = true;
    for (let reader = nextReader(); reader; reader = nextReader()) {
      if (hooks.shouldStop?.()) {
        complete = false;
        break;
      }
      const chunkStart = Time.now();
      const synced = await this.syncChunkWithRetries(
        reader,
        chunks + 1,
        settings
      );
      retries += synced.retries;
      if (!synced.result) break;
      slowestChunkMs = Math.max(
        slowestChunkMs,
        chunkStart.diffFromNow().toMillis()
      );
      chunks++;
      rows += synced.result.chunk.rows.length;
      updated += synced.result.updated;
      await hooks.afterChunk?.(chunks);
      if (!advance(synced.result.chunk)) break;
    }
    logger.info(
      `${label === 'SCOPED' ? '[SCOPED] ' : ''}[SYNCED ${rows} IDENTITIES IN ${chunks} CHUNKS] [UPDATED ${updated}] [${complete ? 'COMPLETE' : 'STOPPED AT BUDGET'}] [RETRIES ${retries}] [SLOWEST CHUNK ${slowestChunkMs} ms] [${start.diffFromNow()}]`
    );
    return { complete, chunks, rows, updated, retries, slowestChunkMs };
  }

  private async syncChunkWithRetries(
    read: ChunkReader,
    chunkNumber: number,
    settings: ChunkSettings
  ): Promise<{ result: SyncedChunk | null; retries: number }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.executeNativeQueriesInTransaction(
          (connection) =>
            this.syncChunk(read, chunkNumber, settings, connection)
        );
        return { result, retries: attempt - 1 };
      } catch (error) {
        if (!isRetryable(error) || attempt >= CHUNK_ATTEMPTS) throw error;
        logger.warn(
          `[CHUNK ${chunkNumber} RETRY ${attempt}] ${(error as Error).message}`
        );
        await Time.millis(RETRY_BASE_DELAY_MS * attempt).sleep();
      }
    }
  }

  private async syncChunk(
    read: ChunkReader,
    chunkNumber: number,
    settings: ChunkSettings,
    connection: ConnectionWrapper<any>
  ): Promise<SyncedChunk | null> {
    const chunk = await read(connection);
    if (!chunk) return null;
    const keyCondition = (column: string) =>
      selectorCondition(chunk.selector, column);
    // 1. Shared locks on the sources, before any identities lock.
    const tdhRows = keyCondition('consolidation_key');
    await this.db.execute(
      `select count(*) as n from ${CONSOLIDATED_WALLETS_TDH_TABLE}
       where ${tdhRows.sql}
       for share`,
      tdhRows.params,
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
    const identityRows = keyCondition('i.consolidation_key');
    const update = await this.db.execute(
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
       where ${identityRows.sql}
         and (i.rep <> coalesce(r.rep, 0)
           or i.cic <> coalesce(r.cic, 0)
           or i.tdh <> coalesce(c.boosted_tdh, 0)
           or i.basetdh_rate <> coalesce(c.boosted_tdh_rate, 0)
           or i.level_raw <> coalesce(r.rep, 0) + coalesce(c.boosted_tdh, 0) + i.xtdh)`,
      { ...identityRows.params, profileIds },
      { wrappedConnection: connection }
    );
    // 3. The UPDATE locked the chunk's rows (a whole key range for the walk).
    // If its rows are not the ones read in step 0 (a row was added or
    // removed, or a profile id changed), some row may have been summed
    // against the wrong ratings: roll back and redo the chunk.
    const lockedRows = keyCondition('consolidation_key');
    const locked = await this.db.execute<ChunkRow>(
      `select consolidation_key, profile_id from ${IDENTITIES_TABLE}
       where ${lockedRows.sql}
       order by consolidation_key asc
       for share`,
      lockedRows.params,
      { wrappedConnection: connection }
    );
    if (!sameRows(chunk.rows, locked)) throw new IdentityChunkChangedError();
    // Commits with the chunk, so a resumed walk never skips or redoes it.
    await settings.recordProgress?.(chunk.last, connection);
    return { chunk, updated: changedRowsOf(update) };
  }

  /** Step 0 of a walk chunk: the next keys and profile ids, without locking. */
  private async readRangeChunk(
    after: string,
    chunkRows: number,
    { profileIdBytes }: ChunkSettings,
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
    const last = rows[rows.length - 1].consolidation_key;
    return {
      selector: { kind: 'RANGE', after, last },
      last,
      rows,
      profileIds: Array.from(profileIds)
    };
  }

  /** Step 0 of a scoped chunk: its keys' current rows, without locking. */
  private async readKeysChunk(
    keys: string[],
    connection: ConnectionWrapper<any>
  ): Promise<Chunk | null> {
    const rows = await this.db.execute<ChunkRow>(
      `select consolidation_key, profile_id from ${IDENTITIES_TABLE}
       where consolidation_key in (:keys)
       order by consolidation_key asc`,
      { keys },
      { wrappedConnection: connection }
    );
    return {
      selector: { kind: 'KEYS', keys },
      last: rows.length ? rows[rows.length - 1].consolidation_key : '',
      rows,
      profileIds: profileIdsOf(rows)
    };
  }

  /** The current identities of the given keys and profiles, by key. */
  private async readScopedRows(
    consolidationKeys: string[],
    profileIds: string[]
  ): Promise<ChunkRow[]> {
    const read =
      (column: 'consolidation_key' | 'profile_id') =>
      async (values: string[]) =>
        this.db.execute<ChunkRow>(
          `select consolidation_key, profile_id from ${IDENTITIES_TABLE}
           where ${column} in (:values)`,
          { values },
          { forcePool: DbPoolName.WRITE }
        );
    const rows = [
      ...(await querySqlInListChunks(
        consolidationKeys,
        read('consolidation_key'),
        { sequential: true }
      )),
      ...(await querySqlInListChunks(profileIds, read('profile_id'), {
        sequential: true
      }))
    ];
    const byKey = new Map(rows.map((row) => [row.consolidation_key, row]));
    return Array.from(byKey.values()).sort((a, b) =>
      compareKeys(a.consolidation_key, b.consolidation_key)
    );
  }
}

export const identityMetricsSync = new IdentityMetricsSync(dbSupplier);
