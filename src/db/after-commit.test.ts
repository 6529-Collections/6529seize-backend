import {
  afterCommit,
  closeAfterCommitScope,
  openAfterCommitScope,
  runAfterCommitCallbacks
} from './after-commit';

describe('afterCommit', () => {
  afterEach(() => {
    jest.useRealTimers();
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
