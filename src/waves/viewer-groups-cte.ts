import { DB_TEXT_COLLATION } from '@/db/db-collation';
import { Logger } from '@/logging';
import { SqlExecutor } from '@/sql-executor';

const logger = Logger.get('VIEWER_GROUPS_CTE');

export interface ViewerGroupsCte {
  /** `<name> as (...)`, for the statement's WITH list. */
  readonly cteSql: string;
  /** A subquery over the groups, used in place of an inlined list. */
  readonly setSql: string;
  /** The JSON parameter the CTE reads. */
  readonly params: Record<string, string>;
}

/**
 * The viewer's eligible group ids as one shared table, so a statement
 * inlines them once (as one JSON parameter) instead of once per visibility
 * check. The ids are cast to DB_TEXT_COLLATION, the compared columns'
 * collation, so `IN (SELECT ...)` matches exactly as an inlined literal list
 * does and needs no conversion; use it only where viewerGroupsCteSupported
 * says the columns use that collation.
 *
 * Each reference reads the groups through two hints, so the JSON is parsed
 * once per statement rather than once per checked row:
 * - NO_MERGE materializes the shared table once, and every reference reuses
 *   it (otherwise each reference re-reads JSON_TABLE).
 * - SUBQUERY(MATERIALIZATION) runs each `IN` once into a deduplicated,
 *   indexed table. The `IN` sits under OR, so it can't be a semijoin; without
 *   the hint the optimizer may pick a correlated EXISTS that re-reads the
 *   groups for every row (seen on production plans).
 */
export function viewerGroupsCte(
  name: string,
  groupIds: readonly string[]
): ViewerGroupsCte {
  const param = `${name}_json`;
  return {
    cteSql: `${name} as (
        select convert(viewer_group.id using utf8mb4) collate ${DB_TEXT_COLLATION} as id
        from json_table(:${param}, '$[*]' columns (id varchar(200) path '$')) viewer_group
      )`,
    setSql: `select /*+ NO_MERGE(${name}) SUBQUERY(MATERIALIZATION) */ id from ${name}`,
    params: { [param]: JSON.stringify(groupIds) }
  };
}

const support = new Map<string, Promise<boolean>>();
let pinned: boolean | undefined;

/**
 * Whether every listed table's visibility_group_id uses DB_TEXT_COLLATION,
 * the collation the shared table is cast to. Read once per container and
 * table set; a failed read is retried on a later call (callers keep the
 * inlined list meanwhile).
 */
export function viewerGroupsCteSupported(
  db: SqlExecutor,
  tables: readonly string[]
): Promise<boolean> {
  if (pinned !== undefined) return Promise.resolve(pinned);
  const key = JSON.stringify([...tables].sort((a, b) => a.localeCompare(b)));
  let check = support.get(key);
  if (!check) {
    check = db
      .execute<{ collation_name: string | null }>(
        `select collation_name as collation_name
         from information_schema.columns
         where table_schema = database()
           and column_name = 'visibility_group_id'
           and table_name in (:tables)`,
        { tables: [...tables] }
      )
      .then((rows) => {
        const supported =
          rows.length === tables.length &&
          rows.every((row) => row.collation_name === DB_TEXT_COLLATION);
        if (!supported)
          logger.warn('[VIEWER_GROUPS_CTE_DISABLED] collation mismatch', {
            tables: key,
            expected: DB_TEXT_COLLATION,
            found: rows.map((row) => row.collation_name)
          });
        return supported;
      })
      .catch(() => {
        support.delete(key);
        return false;
      });
    support.set(key, check);
  }
  return check;
}

/** Test seam: forget the cached collation checks, or pin their result. */
export function resetViewerGroupsCteSupport(supported?: boolean): void {
  support.clear();
  pinned = supported;
}
