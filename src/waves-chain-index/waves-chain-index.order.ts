/** UTF-16 code unit order: the same on every container, unlike locales. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
