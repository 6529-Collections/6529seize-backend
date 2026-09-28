/** A discovery or delivery failure must not prevent another execution engine
 * from running. Propagate failure only after every independent task was tried. */
export async function runCompetitionWorkerTasks(
  tasks: readonly (() => Promise<void>)[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
