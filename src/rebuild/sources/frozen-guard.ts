import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The one frozen node the machine runs at a time. */
export const FROZEN_LOCK = path.join(os.tmpdir(), 'rebuild-frozen-node.lock');

interface LockOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly purpose: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes the frozen-node lock for this process, or says why not: another
 * live process holds it. A lock whose holder has exited is taken over.
 * Returns the release function.
 */
export function takeFrozenLock(
  purpose: string,
  lockDir: string = FROZEN_LOCK
): { release: () => void } | { refused: string } {
  const ownerFile = path.join(lockDir, 'owner.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: LockOwner | null = null;
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as LockOwner;
      } catch {
        owner = null;
      }
      // This process too: a second frozen node from one run is a second one.
      if (owner && alive(owner.pid)) {
        return {
          refused: `another frozen node is running (process ${owner.pid}, since ${owner.startedAt}, for ${owner.purpose}); one runs at a time`
        };
      }
      if (!owner) {
        // Being written by a holder that just took it, or left half
        // written: either way not ours to take.
        return {
          refused: `the frozen-node lock ${lockDir} has no owner file; one frozen node runs at a time`
        };
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    const owner: LockOwner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      purpose
    };
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    return {
      release: () => fs.rmSync(lockDir, { recursive: true, force: true })
    };
  }
  return { refused: `the frozen-node lock ${lockDir} could not be taken` };
}
