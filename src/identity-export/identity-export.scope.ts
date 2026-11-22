import { IdentityExportRating } from './identity-export.types';

/**
 * Which identities the 6529 chain imports, with the bulk rule as the
 * snapshot builder applies it:
 * - core: a real handle, two or more wallets, or waves activity;
 * - and every profile at either end of a REP or CIC rating, except that a
 *   rating in a bulk category (one rater's REP category with more than
 *   `bulkThreshold` targets, such as holder tags) does not bring its target
 *   in (its rater gave a rating, so it is in).
 * Every rating whose two ends are both in is exported, bulk or not.
 * `bulkThreshold` 0 turns the bulk rule off.
 */

const PLACEHOLDER_PREFIX = 'id-0x';

/** Code point order, as the snapshot tooling (Python) sorts strings. */
export function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function isPlaceholderHandle(handle: string | null): boolean {
  return !!handle && handle.toLowerCase().startsWith(PLACEHOLDER_PREFIX);
}

export function isRealHandle(handle: string | null): boolean {
  return !!handle && !isPlaceholderHandle(handle);
}

export type RatingEdge = IdentityExportRating;

function bulkKey(rater: string, category: string): string {
  return `${rater}\u0000${category}`;
}

export interface BulkCategory {
  readonly rater_profile_id: string;
  readonly category: string;
  readonly targets: number;
}

/** Raters' REP categories with more than `threshold` targets (0: none). */
export function findBulkCategories(
  edges: readonly RatingEdge[],
  threshold: number
): BulkCategory[] {
  if (threshold <= 0) {
    return [];
  }
  const counts = new Map<string, BulkCategory>();
  for (const edge of edges) {
    if (edge.matter !== 'REP') {
      continue;
    }
    const key = bulkKey(edge.rater_profile_id, edge.category);
    const current = counts.get(key);
    counts.set(key, {
      rater_profile_id: edge.rater_profile_id,
      category: edge.category,
      targets: (current?.targets ?? 0) + 1
    });
  }
  return Array.from(counts.values())
    .filter((it) => it.targets > threshold)
    .sort(
      (a, b) =>
        b.targets - a.targets ||
        compareCodePoints(a.rater_profile_id, b.rater_profile_id) ||
        compareCodePoints(a.category, b.category)
    );
}

export function isBulkEdge(
  edge: RatingEdge,
  bulk: ReadonlySet<string>
): boolean {
  return (
    edge.matter === 'REP' &&
    bulk.has(bulkKey(edge.rater_profile_id, edge.category))
  );
}

export function bulkKeys(categories: readonly BulkCategory[]): Set<string> {
  return new Set(
    categories.map((it) => bulkKey(it.rater_profile_id, it.category))
  );
}

export interface RatingScope {
  /** Profiles in: the core and the ends of non-bulk ratings. */
  readonly profiles: Set<string>;
  /** Ratings with both ends in. */
  readonly ratings: RatingEdge[];
  /** Profiles at an end of an exported rating (the "rating" scope). */
  readonly rated: Set<string>;
  /** Bulk ratings left out because an end is not in. */
  readonly bulkLeftOut: number;
}

/**
 * The profiles and ratings in scope. `excluded` are profiles that can't be
 * exported (no identity or profile row): ratings naming them are dropped
 * before anything else, so they bring no one in.
 */
export function selectRatingScope({
  core,
  edges,
  bulk,
  excluded
}: {
  readonly core: ReadonlySet<string>;
  readonly edges: readonly RatingEdge[];
  readonly bulk: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
}): RatingScope {
  const usable = edges.filter(
    (edge) =>
      edge.rater_profile_id !== edge.target_profile_id &&
      !excluded.has(edge.rater_profile_id) &&
      !excluded.has(edge.target_profile_id)
  );
  const profiles = new Set<string>();
  core.forEach((it) => {
    if (!excluded.has(it)) profiles.add(it);
  });
  for (const edge of usable) {
    // A rater always gave a rating; a bulk rating brings no target in.
    profiles.add(edge.rater_profile_id);
    if (!isBulkEdge(edge, bulk)) {
      profiles.add(edge.target_profile_id);
    }
  }
  const ratings: RatingEdge[] = [];
  const rated = new Set<string>();
  let bulkLeftOut = 0;
  for (const edge of usable) {
    if (
      profiles.has(edge.rater_profile_id) &&
      profiles.has(edge.target_profile_id)
    ) {
      ratings.push(edge);
      rated.add(edge.rater_profile_id);
      rated.add(edge.target_profile_id);
    } else {
      bulkLeftOut++;
    }
  }
  return { profiles, ratings, rated, bulkLeftOut };
}

/**
 * Diagnostic only: the profiles the public-API exporter reaches (the core,
 * then two rounds of each read profile's received ratings and its non-bulk
 * given ones). A difference between the two exports outside this reach is
 * expected and explained by it.
 */
export function publicExporterReach({
  core,
  edges,
  bulk
}: {
  readonly core: ReadonlySet<string>;
  readonly edges: readonly RatingEdge[];
  readonly bulk: ReadonlySet<string>;
}): Set<string> {
  const received = new Map<string, string[]>();
  const given = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of edges) {
    push(received, edge.target_profile_id, edge.rater_profile_id);
    if (!isBulkEdge(edge, bulk)) {
      push(given, edge.rater_profile_id, edge.target_profile_id);
    }
  }
  const reach = new Set<string>(core);
  let frontier = Array.from(core);
  for (let round = 0; round < 2; round++) {
    const next: string[] = [];
    for (const profile of frontier) {
      for (const other of [
        ...(received.get(profile) ?? []),
        ...(given.get(profile) ?? [])
      ]) {
        if (!reach.has(other)) {
          reach.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return reach;
}

export function compareRatings(
  a: IdentityExportRating,
  b: IdentityExportRating
): number {
  return (
    compareCodePoints(a.rater_profile_id, b.rater_profile_id) ||
    compareCodePoints(a.matter, b.matter) ||
    compareCodePoints(a.target_profile_id, b.target_profile_id) ||
    compareCodePoints(a.category.toLowerCase(), b.category.toLowerCase()) ||
    compareCodePoints(a.category, b.category)
  );
}
