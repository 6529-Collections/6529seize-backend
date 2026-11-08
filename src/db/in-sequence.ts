/**
 * Runs `tasks` one after another, stops at the first failure and resolves
 * to their results in order (a tuple for an array literal of tasks).
 *
 * Use it instead of `Promise.all` for statements on one transaction
 * connection. The connection runs one statement at a time anyway, so nothing
 * is gained, and with `Promise.all` a failure leaves the other tasks running:
 * their statements still reach the connection after the transaction ended
 * (an InnoDB deadlock rolls it back at once, other errors on the following
 * ROLLBACK), so they run outside it and their writes commit on their own.
 * Budgeted transactions (`executionBudget`) reject overlapping statements.
 */
export async function inSequence<
  const T extends readonly (() => Promise<unknown>)[]
>(tasks: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
