import { Logger } from '@/logging';
import {
  afterCommit,
  afterCommitAwaited,
  afterCommitMark,
  beforeCommit,
  closeAfterCommitScope,
  dropAfterCommitSince,
  openAfterCommitScope,
  runAfterCommitCallbacks,
  runBeforeCommitChecks
} from './after-commit';

describe('afterCommit', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs at once without a tracked transaction', async () => {
    const effect = jest.fn();

    await afterCommit(undefined, effect);
    await afterCommit({ connection: {} }, effect);

    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('defers to COMMIT, keeps one callback per key and drops them on rollback', async () => {
    const connection = {};
    const keyed = jest.fn();
    const unkeyed = jest.fn();
    openAfterCommitScope(connection);

    await afterCommit({ connection }, keyed, 'same');
    await afterCommit({ connection }, keyed, 'same');
    await afterCommit({ connection }, unkeyed);
    await afterCommit({ connection }, unkeyed);
    expect(keyed).not.toHaveBeenCalled();

    await runAfterCommitCallbacks(closeAfterCommitScope(connection));
    expect(keyed).toHaveBeenCalledTimes(1);
    expect(unkeyed).toHaveBeenCalledTimes(2);

    openAfterCommitScope(connection);
    await afterCommit({ connection }, keyed, 'same');
    closeAfterCommitScope(connection);
    expect(keyed).toHaveBeenCalledTimes(1);
  });

  it('waits for slow callbacks only up to its budget', async () => {
    jest.useFakeTimers();
    let settled = false;
    const run = runAfterCommitCallbacks([
      () => new Promise<void>(() => undefined)
    ]).then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await run;
    expect(settled).toBe(true);
  });

  it('waits in full for an awaited callback, past the budget, and the others only up to it', async () => {
    jest.useFakeTimers();
    const connection = {};
    let awaitedDone = false;
    openAfterCommitScope(connection);
    await afterCommitAwaited({ connection }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      awaitedDone = true;
    });
    await afterCommit({ connection }, () => new Promise<void>(() => undefined));
    let settled = false;
    const run = runAfterCommitCallbacks(closeAfterCommitScope(connection)).then(
      () => {
        settled = true;
      }
    );

    await jest.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(4_000);
    await run;
    expect(awaitedDone).toBe(true);
    expect(settled).toBe(true);
  });

  it('runs an awaited callback at once without a tracked transaction, waits for it, and drops it on rollback', async () => {
    const order: string[] = [];
    await afterCommitAwaited(undefined, async () => {
      await Promise.resolve();
      order.push('ran');
    });
    order.push('returned');
    expect(order).toEqual(['ran', 'returned']);

    const connection = {};
    const dropped = jest.fn();
    openAfterCommitScope(connection);
    await afterCommitAwaited({ connection }, dropped);
    closeAfterCommitScope(connection);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('logs and swallows an awaited callback failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const failure = new Error('shadow');
    await expect(
      afterCommitAwaited(undefined, () => Promise.reject(failure))
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('After-commit callback failed', failure);
  });

  it('drops the work registered after a savepoint mark when the savepoint is rolled back', async () => {
    const connection = {};
    const kept = jest.fn();
    const undone = jest.fn();
    const keptCheck = jest.fn();
    const undoneCheck = jest.fn();
    expect(afterCommitMark({ connection })).toBeNull();
    dropAfterCommitSince({ connection }, null);

    openAfterCommitScope(connection);
    await afterCommit({ connection }, kept);
    beforeCommit({ connection }, 'kept', keptCheck);
    const mark = afterCommitMark({ connection });
    await afterCommitAwaited({ connection }, undone);
    await afterCommit({ connection }, undone);
    beforeCommit({ connection }, 'undone', undoneCheck);
    dropAfterCommitSince({ connection }, mark);

    runBeforeCommitChecks(connection);
    await runAfterCommitCallbacks(closeAfterCommitScope(connection));
    expect(kept).toHaveBeenCalledTimes(1);
    expect(keptCheck).toHaveBeenCalledTimes(1);
    expect(undone).not.toHaveBeenCalled();
    expect(undoneCheck).not.toHaveBeenCalled();
  });

  it('swallows callback failures', async () => {
    await expect(
      runAfterCommitCallbacks([
        () => {
          throw new Error('sync');
        },
        () => Promise.reject(new Error('async'))
      ])
    ).resolves.toBeUndefined();
  });
});
