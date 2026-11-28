/**
 * Level bounds in a form that admits the same members whether levels end at
 * 100, as they do now, or keep counting above 100.
 *
 * Today a level_max of 100 or more admits everyone at the top, and a
 * level_min above 100 admits nobody. Once levels go above 100, both would
 * mean something else. A save stores them like this instead:
 *
 * - level_min above 100 with level_max NULL or 100 or more: level_max -1. A
 *   negative level_max admits nobody by criteria under either rule.
 * - level_max of 100 or more: level_max NULL, and a NULL level_min becomes 0.
 *   A level_min of 0 or less admits every level, as the old level_max did.
 *
 * Neither form drops the level criterion: a group with a level bound is a
 * criteria group, whose members join its include list. The migration
 * 20261122180000-rewrite-group-level-bounds-for-uncapped-levels applies the
 * same rewrite to groups saved before.
 */
export function toRuleNeutralLevelBounds({
  level_min,
  level_max
}: {
  level_min: number | null;
  level_max: number | null;
}): { level_min: number | null; level_max: number | null } {
  if (level_min !== null && level_min > 100) {
    if (level_max === null || level_max >= 100) {
      return { level_min, level_max: -1 };
    }
    return { level_min, level_max };
  }
  if (level_max !== null && level_max >= 100) {
    return { level_min: level_min ?? 0, level_max: null };
  }
  return { level_min, level_max };
}
