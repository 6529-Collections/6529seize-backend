import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The one frozen node the machine runs at a time. */
export const FROZEN_LOCK = path.join(os.tmpdir(), 'rebuild-frozen-node.lock');

interface LockOwner {
  readonly pid: number;
  /** The frozen node's own process, once started. */
  readonly nodePid?: number;
  readonly startedAt: string;
  readonly purpose: string;
}

/** A held lock: it names the node's process too, and is given back once. */
export interface FrozenLock {
  /** Names the frozen node's process, so the lock stays held while it lives. */
  holdFor(nodePid: number): void;
  release(): void;
}

function alive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes the frozen-node lock for this process, or says why not: another
 * holder whose process or whose node's process still lives. A lock whose
 * processes have both exited is taken over.
 */
export function takeFrozenLock(
  purpose: string,
  lockDir: string = FROZEN_LOCK
): FrozenLock | { refused: string } {
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
      if (owner && (alive(owner.pid) || alive(owner.nodePid))) {
        const node = owner.nodePid ? `, node ${owner.nodePid}` : '';
        return {
          refused: `another frozen node is running (process ${owner.pid}${node}, since ${owner.startedAt}, for ${owner.purpose}); one runs at a time`
        };
      }
      if (!owner) {
        // Being written by a holder that just took it, or left half
        // written: either way not ours to take.
        return {
          refused:
            'the frozen-node lock has no owner file; one frozen node runs at a time'
        };
      }
      fs.rmSync(lockDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
      continue;
    }
    let owner: LockOwner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      purpose
    };
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    let released = false;
    return {
      holdFor: (nodePid: number) => {
        owner = { ...owner, nodePid };
        fs.writeFileSync(ownerFile, JSON.stringify(owner));
      },
      release: () => {
        if (released) return;
        released = true;
        fs.rmSync(lockDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200
        });
      }
    };
  }
  return { refused: 'the frozen-node lock could not be taken' };
}
