/**
 * Waits until `answers()` says the API is up. False when the API process
 * ended first (`ended()`), or nothing answered within `timeoutMs`: the run
 * then fails, whatever the exit code, so no run passes without answers.
 */
export async function waitForApi(options: {
  answers: () => Promise<boolean>;
  ended: () => boolean;
  timeoutMs: number;
  pauseMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline && !options.ended()) {
    if (await options.answers()) return true;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
  }
  return false;
}
