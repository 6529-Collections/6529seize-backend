import { AreaManifest, validUntil } from '@/rebuild/manifest.types';

/** An EXEMPT table exempt only until a day, as a run sees it. */
export interface ExemptUntil {
  readonly table: string;
  /** The last day of the exemption, YYYY-MM-DD. */
  readonly until: string;
  readonly why: string;
  /** The run's day (UTC) is past `until`. */
  readonly overdue: boolean;
}

/** Anything with a last day: an EXEMPT table, or a plan of planned rows. */
export interface Dated {
  readonly table: string;
  readonly until: string;
  readonly overdue: boolean;
}

/** The run's day, UTC, YYYY-MM-DD. */
export function runDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The EXEMPT tables that name an `until`, in table order, each marked
 * overdue once `today` is past its day. One that isn't a real day is left
 * out: the registry check refuses it.
 */
export function exemptUntil(
  manifests: readonly AreaManifest[],
  today: string
): ExemptUntil[] {
  const result: ExemptUntil[] = [];
  for (const manifest of manifests) {
    for (const [table, entry] of Object.entries(manifest.tables)) {
      if (entry.class !== 'EXEMPT' || entry.until === undefined) continue;
      if (!validUntil(entry.until)) continue;
      result.push({
        table,
        until: entry.until,
        why: entry.why ?? '',
        overdue: today > entry.until
      });
    }
  }
  return result.sort((a, b) =>
    a.table < b.table ? -1 : Number(a.table > b.table)
  );
}

/**
 * The headline's line for what is past its day: EXEMPT tables, then
 * plans of planned rows; null when nothing is.
 */
export function overdueLine(
  exempt: readonly Dated[],
  plans: readonly Dated[] = []
): string | null {
  const since = (entries: readonly Dated[]) =>
    Array.from(
      new Set(
        entries
          .filter((e) => e.overdue)
          .map((e) => `${e.table} since ${e.until}`)
      )
    );
  const parts: string[] = [];
  const tables = since(exempt);
  if (tables.length) parts.push(`EXEMPT overdue: ${tables.join(', ')}`);
  const planned = since(plans);
  if (planned.length) {
    parts.push(`planned rows overdue: ${planned.join(', ')}`);
  }
  return parts.length ? parts.join('; ') : null;
}
