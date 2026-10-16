/** A comparison owns one transaction connection. Chain reads so a later page
 * cannot start before the prior page completes, or after it fails.
 * Reads populate caller-owned state; this helper intentionally returns no values. */
export function readSequentially<T>(
  items: readonly T[],
  read: (item: T) => Promise<void>
): Promise<void> {
  return items.reduce<Promise<void>>(
    (pending, item) => pending.then(() => read(item)),
    Promise.resolve()
  );
}
