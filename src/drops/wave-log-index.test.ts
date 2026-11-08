import { SqlExecutor } from '@/sql-executor';
import { resetWaveLogIndexReady, waveLogIndexReady } from './wave-log-index';

function executorReturning(...results: (unknown[] | Error)[]) {
  const execute = jest.fn(async () => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  });
  return { db: { execute } as unknown as SqlExecutor, execute };
}

describe('waveLogIndexReady', () => {
  beforeEach(() => resetWaveLogIndexReady());

  it('remembers a present index', async () => {
    const { db, execute } = executorReturning([{ found: 1 }]);
    await expect(waveLogIndexReady(db, 0)).resolves.toBe(true);
    await expect(waveLogIndexReady(db, 60 * 60_000)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('checks a missing index again after a few minutes', async () => {
    const { db, execute } = executorReturning([], [{ found: 1 }]);
    await expect(waveLogIndexReady(db, 0)).resolves.toBe(false);
    await expect(waveLogIndexReady(db, 60_000)).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(waveLogIndexReady(db, 5 * 60_000)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('treats a failed check as missing and retries it sooner', async () => {
    const { db, execute } = executorReturning(new Error('down'), [
      { found: 1 }
    ]);
    await expect(waveLogIndexReady(db, 0)).resolves.toBe(false);
    await expect(waveLogIndexReady(db, 10_000)).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(waveLogIndexReady(db, 30_000)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('shares one check between concurrent callers', async () => {
    const { db, execute } = executorReturning([{ found: 1 }]);
    await expect(
      Promise.all([waveLogIndexReady(db, 0), waveLogIndexReady(db, 0)])
    ).resolves.toEqual([true, true]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
