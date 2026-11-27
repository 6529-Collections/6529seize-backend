/**
 * UTF-16 code unit order, for every sort in the rebuild check: the same on
 * every machine, unlike localeCompare, whose order follows the locale.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
