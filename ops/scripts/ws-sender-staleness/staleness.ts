/**
 * Pre-rollout check for WebSocket audience changes (for example the
 * typing-purpose filter that must reach every sender before the frontend's
 * typing socket ships): which Lambdas actually send WebSocket frames, and is
 * each one's deployed commit at or after a required commit?
 *
 * A source-code guard cannot see this: a sender deployed before the change
 * keeps the old audience until it is redeployed.
 */

export interface DeployedFunction {
  readonly name: string;
  /** Deploy workflow description, `<sha> - <date> - <ref> - <subject>`. */
  readonly description: string;
}

export type SenderStatus = 'current' | 'stale' | 'unknown-commit';

export interface SenderReport {
  readonly name: string;
  readonly commit: string | null;
  readonly status: SenderStatus;
}

export interface StalenessDeps {
  /** True when the function wrote delivery EMF in the lookback window. */
  readonly sendsFrames: (functionName: string) => Promise<boolean>;
  /** True when `required` is an ancestor of (or equal to) `deployed`. */
  readonly contains: (deployed: string, required: string) => Promise<boolean>;
  /** True when the commit exists in the local clone. */
  readonly knows: (commit: string) => Promise<boolean>;
}

const COMMIT = /^([0-9a-f]{7,40})\s/;

/** The deployed commit from a deploy workflow description, or null. */
export function deployedCommit(description: string): string | null {
  return COMMIT.exec(description.trim())?.[1] ?? null;
}

/**
 * Reports every function that sends WebSocket frames, sorted stale first.
 * Functions that send nothing are left out: their audience never matters.
 */
export async function findStaleSenders(
  functions: readonly DeployedFunction[],
  requiredCommit: string,
  deps: StalenessDeps,
  concurrency = 8
): Promise<SenderReport[]> {
  const reports: SenderReport[] = [];
  // Log searches are slow per function, so a few run at once.
  let next = 0;
  const worker = async () => {
    while (next < functions.length) {
      const fn = functions[next++];
      if (!(await deps.sendsFrames(fn.name))) continue;
      const commit = deployedCommit(fn.description);
      let status: SenderStatus = 'unknown-commit';
      if (commit && (await deps.knows(commit))) {
        status = (await deps.contains(commit, requiredCommit))
          ? 'current'
          : 'stale';
      }
      reports.push({ name: fn.name, commit, status });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, functions.length) }, worker)
  );
  const order: Record<SenderStatus, number> = {
    stale: 0,
    'unknown-commit': 1,
    current: 2
  };
  return reports.sort(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name)
  );
}
