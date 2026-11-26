import { differingColumns } from '@/rebuild/snapshot/table-snapshot';
import { Row } from '@/rebuild/stack/mysql-admin';

/** A column plan as the comparison needs it. */
export interface ColumnPlanRows {
  /** The plan's columns. */
  readonly columns: readonly string[];
  /** The seeded rows its condition matched, by key. */
  readonly rows: ReadonlyMap<string, Row>;
}

/** What one column plan found after the rebuild. */
export interface ColumnPlanCounts {
  /** Matched rows that came back changed in any of the plan's columns. */
  differing: number;
  /**
   * Of those, the rows left out of the differences: changed only in
   * columns their plans name.
   */
  excused: number;
  /** Per column of the plan, the matched rows changed in it. */
  byColumn: Record<string, number>;
}

/**
 * Which changed rows the column plans excuse, and each plan's counts. A
 * matched row that came back changed only in columns its plans name (the
 * union of every column plan matching it) is excused; a row changed in
 * any other column still differs, and so does a matched row that is
 * missing. `changed` holds the keys whose rows differ on both sides.
 */
export function columnPlanDecision(input: {
  readonly plans: readonly ColumnPlanRows[];
  readonly changed: readonly string[];
  /** The rebuilt rows, by key. */
  readonly rebuilt: ReadonlyMap<string, Row>;
  readonly volatile: ReadonlySet<string>;
}): { excused: Set<string>; counts: ColumnPlanCounts[] } {
  const counts: ColumnPlanCounts[] = input.plans.map(() => ({
    differing: 0,
    excused: 0,
    byColumn: {}
  }));
  const excused = new Set<string>();
  for (const key of input.changed) {
    const covering = input.plans
      .map((plan, i) => ({ plan, i }))
      .filter(({ plan }) => plan.rows.has(key));
    const now = input.rebuilt.get(key);
    if (!covering.length || !now) continue;
    const seeded = covering[0].plan.rows.get(key)!;
    const differ = differingColumns(seeded, now, input.volatile);
    if (!differ.length) continue;
    const allowed = new Set(covering.flatMap(({ plan }) => plan.columns));
    const left = differ.every((column) => allowed.has(column));
    if (left) excused.add(key);
    for (const { plan, i } of covering) {
      const its = differ.filter((column) => plan.columns.includes(column));
      if (!its.length) continue;
      counts[i].differing += 1;
      if (left) counts[i].excused += 1;
      for (const column of its) {
        counts[i].byColumn[column] = (counts[i].byColumn[column] ?? 0) + 1;
      }
    }
  }
  return { excused, counts };
}

/**
 * Why a column plan can't be checked on its table, or null: its columns
 * must be in the schema and outside the primary key, and the table needs
 * a primary key without a volatile column, to find each matched row
 * again after the rebuild.
 */
export function columnPlanProblem(input: {
  readonly step: string;
  readonly table: string;
  readonly columns: readonly string[];
  /** The table's columns in the schema. */
  readonly names: readonly string[];
  readonly primaryKey: readonly string[];
  readonly volatile: ReadonlySet<string>;
}): string | null {
  const { step, table, columns, primaryKey } = input;
  const unknown = columns.filter((column) => !input.names.includes(column));
  if (unknown.length) {
    return `${step} plans columns ${unknown.join(', ')} of ${table}, which the schema doesn't have`;
  }
  if (!primaryKey.length || primaryKey.some((c) => input.volatile.has(c))) {
    return `${step} plans columns of ${table}, which has no primary key without a volatile column to find its rows by after the rebuild`;
  }
  const keyColumns = columns.filter((column) => primaryKey.includes(column));
  if (keyColumns.length) {
    return `${step} plans ${keyColumns.join(', ')} of ${table}, in its primary key; a column plan finds its rows by key`;
  }
  return null;
}

/**
 * A key that both a plan of whole rows and a column plan match, or null:
 * one says the row may be missing, the other that it must come back.
 */
export function rowAndColumnPlanOverlap(
  table: string,
  plans: readonly {
    readonly step: string;
    readonly columns?: readonly string[];
    readonly keys: readonly string[];
  }[]
): string | null {
  for (const columnPlan of plans.filter((p) => p.columns)) {
    // A set: a plan can match tens of thousands of rows.
    const columnKeys = new Set(columnPlan.keys);
    for (const rowPlan of plans.filter((p) => !p.columns)) {
      const both = rowPlan.keys.find((key) => columnKeys.has(key));
      if (both !== undefined) {
        return `planned rows of ${table}: ${rowPlan.step}'s plan of whole rows and ${columnPlan.step}'s column plan both match the row ${both}; a row is either missing or back with planned columns, not both`;
      }
    }
  }
  return null;
}

/**
 * A key that a keep plan and another plan both match, or null: a kept row
 * comes back unchanged, so it can't also be missing or back with planned
 * columns. Keep plans may match the same rows.
 */
export function keptPlanOverlap(
  table: string,
  plans: readonly {
    readonly step: string;
    readonly keep?: boolean;
    readonly keys: readonly string[];
  }[]
): string | null {
  const kept = plans.filter((p) => p.keep);
  for (const other of plans.filter((p) => !p.keep)) {
    const keys = new Set(other.keys);
    for (const keep of kept) {
      const both = keep.keys.find((key) => keys.has(key));
      if (both !== undefined) {
        return `planned rows of ${table}: ${keep.step}'s keep plan and ${other.step}'s plan both match the row ${both}; a kept row comes back unchanged, so no other plan may match it`;
      }
    }
  }
  return null;
}
