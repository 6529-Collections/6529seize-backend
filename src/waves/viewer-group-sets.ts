import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as mysql from 'mysql';
import { requestWriteDeadline } from '@/api/write-transaction-budget';
import { appFeatures } from '@/app-features';
import {
  VIEWER_GROUP_SET_MEMBERS_TABLE,
  VIEWER_GROUP_SETS_TABLE
} from '@/constants/db-tables';
import { DB_TEXT_COLLATION } from '@/db/db-collation';
import { SqlExecutionBudget } from '@/db/sql-execution-budget';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import { redisSetIfAbsent } from '@/redis';
import { SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { ViewerGroupsCte, viewerGroupsCte } from '@/waves/viewer-groups-cte';

/**
 * Large viewer group sets, stored once and read by hash.
 *
 * A viewer with a few hundred eligible groups carries 12-18 KB of group ids
 * in every statement that checks visibility, even as one shared JSON copy
 * (viewerGroupsCte), so those statements pin their RDS Proxy session. With
 * the feature on, such a set is written once to viewer_group_set_members,
 * keyed by the SHA-256 of its sorted ids, and statements carry the 64-char
 * hash instead. Sets are immutable (a membership change is a new hash) and
 * hold no viewer identifier.
 *
 * - The first request that sees a set answers from the JSON copy, as today,
 *   and writes the set: one budgeted write transaction (chunked INSERT
 *   IGNORE, header last), single-flight across containers through Redis. A
 *   failed or skipped write only means the JSON copy is used again.
 * - A hash is used only once its header is readable where the statement
 *   reads, so replica lag can never empty a viewer's groups.
 * - Used sets are touched at most daily; the migrations loop deletes sets
 *   unused for 14 days.
 */

const logger = Logger.get('VIEWER_GROUP_SETS');

/** Below this JSON size the shared JSON copy does not pin anyway. */
export const VIEWER_GROUP_SET_MIN_JSON_BYTES = 8_000;
/** JSON per member insert: the write proxy session must not pin either. */
const WRITE_CHUNK_JSON_BYTES = 11_000;
const KNOWN_FOR_MS = Time.hours(6).toMillis();
const KNOWN_MAX = 5_000;
const TOUCH_EVERY = Time.days(1);
/** Sets last used longer ago are touched before their hash is cached. */
const TOUCH_NOW_AFTER = Time.days(2).toMillis();
const WRITE_LEASE = Time.seconds(10);
export const VIEWER_GROUP_SET_UNUSED_AFTER = Time.days(14);
const METRIC_NAMESPACE = '6529/ViewerGroupSets';

type SetLease = (key: string, ttl: Time) => Promise<boolean | null>;

/** UTF-16 code unit order: the same on every container, unlike locales. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** sha256 of the sorted, de-duplicated ids, joined by newlines. */
export function viewerGroupSetHash(groupIds: readonly string[]): string {
  const ids = Array.from(new Set(groupIds)).sort(compareCodeUnits);
  return createHash('sha256').update(ids.join('\n')).digest('hex');
}

function jsonBytes(groupIds: readonly string[]): number {
  return Buffer.byteLength(mysql.escape(JSON.stringify(groupIds)), 'utf8');
}

/** JSON arrays of the ids, each within `maxBytes` once escaped. */
export function viewerGroupSetJsonChunks(
  groupIds: readonly string[],
  maxBytes = WRITE_CHUNK_JSON_BYTES
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const id of Array.from(new Set(groupIds))) {
    if (current.length && jsonBytes([...current, id]) > maxBytes) {
      chunks.push(JSON.stringify(current));
      current = [];
    }
    current.push(id);
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}

/** The shared table of `viewerGroupsCte`, read from a stored set. */
export function viewerGroupSetCte(name: string, hash: string): ViewerGroupsCte {
  const param = `${name}_set`;
  return {
    cteSql: `${name} as (
        select m.group_id as id
        from ${VIEWER_GROUP_SET_MEMBERS_TABLE} m
        where m.set_hash = :${param}
      )`,
    setSql: viewerGroupsCte(name, []).setSql,
    params: { [param]: hash }
  };
}

const GROUP_ID_MAX_LENGTH = 100;
const WRITE_MILLIS = 1_500;
const WRITE_MIN_MILLIS = 300;
const WRITE_FINALIZATION_MILLIS = 200;

/**
 * A write budget of at most 1.5 s, capped at the request's write deadline
 * when there is one; null when too little time is left to write at all.
 */
function writeBudget(): SqlExecutionBudget | null {
  const now = performance.now();
  const deadline = Math.min(
    now + WRITE_MILLIS,
    requestWriteDeadline() ?? Number.POSITIVE_INFINITY
  );
  const left = deadline - now;
  if (left <= WRITE_MIN_MILLIS) return null;
  return {
    deadlineMonotonicMillis: deadline,
    maxStatementMillis: Math.max(
      1,
      Math.min(500, Math.floor(left - WRITE_FINALIZATION_MILLIS))
    ),
    finalizationReserveMillis: WRITE_FINALIZATION_MILLIS,
    lockWaitSeconds: 1
  };
}

/**
 * Sets last_used_at; false when the header is gone (cleanup deleted the
 * set). Throws when there is no time left to write.
 */
async function touchViewerGroupSet(
  db: SqlExecutor,
  hash: string,
  now: number
): Promise<boolean> {
  const budget = writeBudget();
  if (!budget) throw new Error('No time left to touch the viewer group set');
  return db.executeNativeQueriesInTransaction(
    async (connection) =>
      db.getAffectedRows(
        await db.execute(
          `update ${VIEWER_GROUP_SETS_TABLE}
           set last_used_at = greatest(last_used_at, :now)
           where set_hash = :hash`,
          { hash, now },
          { wrappedConnection: connection }
        )
      ) > 0,
    { executionBudget: budget }
  );
}

function metricEnvironment(): string {
  return (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
}

type SetMetric =
  | 'ViewerGroupSetWrites'
  | 'ViewerGroupSetWriteFailures'
  | 'ViewerGroupSetWritesSkipped'
  | 'ViewerGroupSetTouches'
  | 'ViewerGroupSetsGone';

function recordMetric(metric: SetMetric, groupCount: number): void {
  try {
    if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
      logger.info(`[${metric}]`, { groupCount });
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [['Environment']],
              Metrics: [{ Name: metric, Unit: 'Count' }]
            }
          ]
        },
        Environment: metricEnvironment(),
        [metric]: 1,
        event: 'viewer_group_set',
        group_count: groupCount,
        request_id: loggerContext.get()?.requestId ?? null
      })}\n`
    );
  } catch {
    // Telemetry must never fail a request.
  }
}

/**
 * Writes a set (members, then its header) in one budgeted write transaction,
 * one member insert per JSON chunk so no statement pins the write proxy
 * session. Idempotent: INSERT IGNORE throughout. The header is written only
 * when every id is stored, so a header always means a complete set: INSERT
 * IGNORE can drop a row silently (an over-long id, or ids equal under the
 * column collation), and such a set rolls back and keeps the JSON copy.
 */
export async function storeViewerGroupSet(
  db: SqlExecutor,
  groupIds: readonly string[],
  now = Date.now()
): Promise<string> {
  const ids = Array.from(new Set(groupIds));
  // group_id is varchar(100), as are the compared visibility columns: a
  // longer id would be stored truncated, so such a set keeps the JSON copy.
  if (ids.some((id) => Array.from(id).length > GROUP_ID_MAX_LENGTH))
    throw new Error('Viewer group id longer than the stored column');
  const hash = viewerGroupSetHash(ids);
  const budget = writeBudget();
  if (!budget) throw new Error('No time left to store the viewer group set');
  // Statements run one at a time: the write budget rejects overlaps.
  await db.executeNativeQueriesInTransaction(
    async (connection) => {
      for (const json of viewerGroupSetJsonChunks(ids)) {
        await db.execute(
          `insert ignore into ${VIEWER_GROUP_SET_MEMBERS_TABLE} (set_hash, group_id)
           select :hash, j.id
           from json_table(:json, '$[*]' columns (id varchar(100) path '$')) j`,
          { hash, json },
          { wrappedConnection: connection }
        );
      }
      const [stored] = await db.execute<{ n: number }>(
        `select count(*) as n from ${VIEWER_GROUP_SET_MEMBERS_TABLE} where set_hash = :hash`,
        { hash },
        { wrappedConnection: connection }
      );
      if (Number(stored?.n) !== ids.length)
        throw new Error('Viewer group set stored incompletely');
      await db.execute(
        `insert ignore into ${VIEWER_GROUP_SETS_TABLE} (set_hash, group_count, created_at, last_used_at)
         values (:hash, :count, :now, :now)`,
        { hash, count: ids.length, now },
        { wrappedConnection: connection }
      );
    },
    { executionBudget: budget }
  );
  return hash;
}

export class ViewerGroupSets {
  /** Hash -> when its header was last seen and when it was last touched. */
  private readonly known = new Map<
    string,
    { readonly seenAt: number; touchedAt: number }
  >();
  private readonly writes = new Map<string, Promise<void>>();
  private columnSupport: Promise<boolean> | undefined;

  constructor(
    private readonly lease: SetLease = redisSetIfAbsent,
    private readonly enabled: () => boolean = () =>
      appFeatures.isViewerGroupSetTableEnabled(),
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * The viewer's groups as a shared table for `name`: read from the stored
   * set when there is one, otherwise the JSON copy (viewerGroupsCte). Never
   * throws for the set store; callers have already checked the compared
   * columns' collation (viewerGroupsCteSupported).
   */
  async source(
    db: SqlExecutor,
    name: string,
    groupIds: readonly string[]
  ): Promise<ViewerGroupsCte> {
    return (
      (await this.stored(db, name, groupIds)) ?? viewerGroupsCte(name, groupIds)
    );
  }

  /**
   * The viewer's groups as a shared table for `name`, read from the stored
   * set; undefined while there is none to read (feature off, a set below the
   * size worth storing, or first sight, which writes the set for the next
   * request). For statements that otherwise inline their one copy of the
   * groups: they keep the inlined list until the set is readable. Never
   * throws for the set store; callers have already checked the compared
   * columns' collation (viewerGroupsCteSupported).
   */
  async stored(
    db: SqlExecutor,
    name: string,
    groupIds: readonly string[]
  ): Promise<ViewerGroupsCte | undefined> {
    if (
      !this.enabled() ||
      jsonBytes(groupIds) < VIEWER_GROUP_SET_MIN_JSON_BYTES
    )
      return undefined;
    try {
      if (!(await this.membersColumnSupported(db))) return undefined;
      const hash = viewerGroupSetHash(groupIds);
      if (
        (await this.usable(db, hash, groupIds.length)) &&
        (await this.touchIfDue(db, hash, groupIds.length))
      )
        return viewerGroupSetCte(name, hash);
      await this.writeOnce(db, hash, groupIds);
    } catch (error) {
      logger.warn('[VIEWER_GROUP_SET_SKIPPED]', {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    return undefined;
  }

  /** Test seam: forget what this container knows. */
  reset(): void {
    this.known.clear();
    this.writes.clear();
    this.columnSupport = undefined;
  }

  private membersColumnSupported(db: SqlExecutor): Promise<boolean> {
    this.columnSupport ??= db
      .execute<{ collation_name: string | null }>(
        `select collation_name as collation_name
         from information_schema.columns
         where table_schema = database()
           and table_name = :table
           and column_name = 'group_id'`,
        { table: VIEWER_GROUP_SET_MEMBERS_TABLE }
      )
      .then((rows) => rows[0]?.collation_name === DB_TEXT_COLLATION)
      .catch(() => {
        this.columnSupport = undefined;
        return false;
      });
    return this.columnSupport;
  }

  /**
   * Whether the set's header is readable where statements read. A set is
   * cached only while it is far from cleanup: one last used more than
   * `TOUCH_NOW_AFTER` ago is touched first (and dropped if it is gone), so a
   * cached hash always outlives the cache entry.
   */
  private async usable(
    db: SqlExecutor,
    hash: string,
    groupCount: number
  ): Promise<boolean> {
    const entry = this.known.get(hash);
    const now = this.now();
    if (entry && now - entry.seenAt < KNOWN_FOR_MS) return true;
    const [header] = await db.execute<{ last_used_at: number }>(
      `select last_used_at from ${VIEWER_GROUP_SETS_TABLE} where set_hash = :hash`,
      { hash }
    );
    let touchedAt = entry?.touchedAt ?? Number.NEGATIVE_INFINITY;
    if (header && now - Number(header.last_used_at) > TOUCH_NOW_AFTER) {
      if (!(await touchViewerGroupSet(db, hash, now))) {
        recordMetric('ViewerGroupSetsGone', groupCount);
        this.known.delete(hash);
        return false;
      }
      recordMetric('ViewerGroupSetTouches', groupCount);
      touchedAt = now;
    }
    if (!header) {
      this.known.delete(hash);
      return false;
    }
    if (this.known.size >= KNOWN_MAX) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
    this.known.set(hash, { seenAt: now, touchedAt });
    return true;
  }

  /**
   * Touches a cached set at most daily. False when the touch finds the set
   * gone: the cached hash is dropped and this request keeps the JSON copy.
   */
  private async touchIfDue(
    db: SqlExecutor,
    hash: string,
    groupCount: number
  ): Promise<boolean> {
    const entry = this.known.get(hash);
    const now = this.now();
    if (!entry || now - entry.touchedAt < TOUCH_EVERY.toMillis()) return true;
    entry.touchedAt = now;
    // Another container touched it today. Without Redis, touch anyway: a
    // one-row update, and a set in use must never look unused to cleanup.
    if (
      (await this.lease(`viewer_group_set:touch:${hash}`, TOUCH_EVERY)) ===
      false
    )
      return true;
    try {
      if (!(await touchViewerGroupSet(db, hash, now))) {
        recordMetric('ViewerGroupSetsGone', groupCount);
        this.known.delete(hash);
        return false;
      }
      recordMetric('ViewerGroupSetTouches', groupCount);
      return true;
    } catch (error) {
      // Re-check the header next time rather than trusting a stale touch.
      this.known.delete(hash);
      throw error;
    }
  }

  /** Writes the set once across containers; this request keeps the JSON copy. */
  private async writeOnce(
    db: SqlExecutor,
    hash: string,
    groupIds: readonly string[]
  ): Promise<void> {
    const pending = this.writes.get(hash);
    if (pending !== undefined) return pending;
    const write = (async () => {
      // Single-flight across containers; without Redis nothing is written,
      // which keeps write bursts bounded.
      if (!(await this.lease(`viewer_group_set:write:${hash}`, WRITE_LEASE))) {
        recordMetric('ViewerGroupSetWritesSkipped', groupIds.length);
        return;
      }
      try {
        await storeViewerGroupSet(db, groupIds, this.now());
        recordMetric('ViewerGroupSetWrites', groupIds.length);
      } catch (error) {
        recordMetric('ViewerGroupSetWriteFailures', groupIds.length);
        throw error;
      }
    })().finally(() => this.writes.delete(hash));
    this.writes.set(hash, write);
    return write;
  }
}

export const viewerGroupSets = new ViewerGroupSets();

/**
 * Deletes sets unused for `VIEWER_GROUP_SET_UNUSED_AFTER`, header and members
 * in one transaction per small batch, re-checking each header under lock so
 * a set touched meanwhile survives. Returns the number of sets deleted.
 */
export async function deleteUnusedViewerGroupSets(
  db: SqlExecutor,
  {
    now = Date.now(),
    batchSize = 10,
    maxBatches = 50
  }: { now?: number; batchSize?: number; maxBatches?: number } = {}
): Promise<number> {
  const cutoff = now - VIEWER_GROUP_SET_UNUSED_AFTER.toMillis();
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const candidates = await db.execute<{ set_hash: string }>(
      `select set_hash from ${VIEWER_GROUP_SETS_TABLE}
       where last_used_at < :cutoff
       order by last_used_at
       limit :batchSize`,
      { cutoff, batchSize }
    );
    if (!candidates.length) break;
    deleted += await db.executeNativeQueriesInTransaction(
      async (connection) => {
        const locked = await db.execute<{ set_hash: string }>(
          `select set_hash from ${VIEWER_GROUP_SETS_TABLE}
           where set_hash in (:hashes) and last_used_at < :cutoff
           for update`,
          { hashes: candidates.map((it) => it.set_hash), cutoff },
          { wrappedConnection: connection }
        );
        if (!locked.length) return 0;
        const hashes = locked.map((it) => it.set_hash);
        await db.execute(
          `delete from ${VIEWER_GROUP_SETS_TABLE} where set_hash in (:hashes)`,
          { hashes },
          { wrappedConnection: connection }
        );
        await db.execute(
          `delete from ${VIEWER_GROUP_SET_MEMBERS_TABLE} where set_hash in (:hashes)`,
          { hashes },
          { wrappedConnection: connection }
        );
        return hashes.length;
      }
    );
    if (candidates.length < batchSize) break;
  }
  return deleted;
}
