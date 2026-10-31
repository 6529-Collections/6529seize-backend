/**
 * Maps `items` with at most `size` calls in flight, keeping input order.
 * Chunks run one after another, so `size` 1 is strictly sequential.
 * Rejects with the first failure.
 */
export async function mapInChunks<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (size < 1) {
    throw new RangeError('size must be at least 1');
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  const results: R[] = [];
  await chunks.reduce<Promise<void>>(async (previous, chunk) => {
    await previous;
    results.push(...(await Promise.all(chunk.map(fn))));
  }, Promise.resolve());
  return results;
}
