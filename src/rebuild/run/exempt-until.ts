import { AreaManifest } from '@/rebuild/manifest.types';

/** An EXEMPT table exempt only until a day, as a run sees it. */
export interface ExemptUntil {
  readonly table: string;
  /** The last day of the exemption, YYYY-MM-DD. */
  readonly until: string;
  readonly why: string;
  /** The run's day (UTC) is past `until`. */
  readonly overdue: boolean;
}

/** Whether `until` is a real calendar day written YYYY-MM-DD. */
export function validUntil(until: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return false;
  const day = new Date(`${until}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(until);
}

/** The run's day, UTC, YYYY-MM-DD. */
export function runDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The EXEMPT tables that name an `until`, in table order, each marked
 * overdue once `today` is past its day. A malformed date never gets here:
 * the registry check refuses it.
 */
export function exemptUntil(
  manifests: readonly AreaManifest[],
  today: string
): ExemptUntil[] {
  return manifests
    .flatMap((manifest) => Object.entries(manifest.tables))
    .filter(([, entry]) => entry.class === 'EXEMPT' && entry.until)
    .map(([table, entry]) => ({
      table,
      until: entry.until as string,
      why: entry.why ?? '',
      overdue: today > (entry.until as string)
    }))
    .sort((a, b) => (a.table < b.table ? -1 : Number(a.table > b.table)));
}

/** The headline's line for the overdue ones, or null when none is. */
export function overdueLine(entries: readonly ExemptUntil[]): string | null {
  const overdue = entries.filter((e) => e.overdue);
  return overdue.length
    ? `EXEMPT overdue: ${overdue.map((e) => `${e.table} since ${e.until}`).join(', ')}`
    : null;
}
