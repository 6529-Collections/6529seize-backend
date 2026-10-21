import {
  COMPETITIONS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import type { SqlExecutor } from '@/sql-executor';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView
} from './legacy-competition-get-facade';

function referencesRelation(definition: string, relation: string): boolean {
  return new RegExp(`(^|[^a-z_0-9])${relation}([^a-z_0-9]|$)`, 'i').test(
    definition
  );
}

/** All views switch only after exact transfer and capture retirement complete.
 * Their native dependencies are the existing cutover boundary, not a new ledger.
 * Missing/partially switched views remain retryable before native-only writers.
 */
export async function isCompetitionRuntimeRetired(
  db: SqlExecutor
): Promise<boolean> {
  const names = LEGACY_GET_SOURCE_TABLES.map(legacyGetView);
  const views = await db.execute<{ name: string; definition: string | null }>(
    `select TABLE_NAME as name,VIEW_DEFINITION as definition from information_schema.VIEWS
     where TABLE_SCHEMA=database() and TABLE_NAME in (:names)`,
    { names }
  );
  if (views.length !== names.length) return false;
  if (views.some((view) => view.definition === null))
    throw new Error(
      'Unable to inspect competition compatibility view definitions'
    );
  const retiredRelations = LEGACY_GET_SOURCE_TABLES.filter(
    (table) => table !== WAVES_TABLE && table !== DROPS_TABLE
  );
  const scoreViews = new Set([
    legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE),
    legacyGetView(DROP_REAL_VOTER_VOTE_IN_TIME_TABLE)
  ]);
  return views.every(({ name, definition }) => {
    const sql = definition!;
    // The prepared wave projection alone still falls back to retired physical
    // configuration without naming a separate retired relation.
    if (
      name === legacyGetView(WAVES_TABLE) &&
      /\bw\s*\.\s*type\b/i.test(sql.replace(/`/g, ''))
    )
      return false;
    return (
      referencesRelation(sql, COMPETITIONS_TABLE) &&
      !retiredRelations.some((table) => referencesRelation(sql, table)) &&
      (!scoreViews.has(name) ||
        referencesRelation(sql, COMPETITION_SCORE_HISTORY_TABLE))
    );
  });
}

export async function assertCompetitionHistoryPreparationAllowed(
  db: SqlExecutor
): Promise<void> {
  if (await isCompetitionRuntimeRetired(db))
    throw new Error(
      'Competition runtime is retired; retained sources are no longer authoritative'
    );
}
