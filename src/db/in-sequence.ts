/**
 * Runs `tasks` one after another, stops at the first failure and resolves
 * to their results in order.
 *
 * Use it instead of `Promise.all` for statements on one transaction
 * connection. The connection runs one statement at a time anyway, so nothing
 * is gained, and with `Promise.all` a failure leaves the other tasks running:
 * their statements still reach the connection after the transaction ended
 * (an InnoDB deadlock rolls it back at once, other errors on the following
 * ROLLBACK), so they run outside it and their writes commit on their own.
 */
export async function inSequence<T>(
  tasks: ReadonlyArray<() => Promise<T>>
): Promise<T[]> {
  const results: T[] = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results;
}
