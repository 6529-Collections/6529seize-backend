import { CompetitionWorkerCursorStore } from './competition-worker-cursor';

function storeWith(db: { oneOrNull: jest.Mock; execute: jest.Mock }) {
  return new CompetitionWorkerCursorStore(() => db as never);
}

const missingTable = Object.assign(new Error('missing'), {
  code: 'ER_NO_SUCH_TABLE'
});

describe('CompetitionWorkerCursorStore', () => {
  it('reads the stored cursor and saves new ones', async () => {
    const db = {
      oneOrNull: jest.fn().mockResolvedValue({ after_id: 'stored' }),
      execute: jest.fn().mockResolvedValue([])
    };
    const store = storeWith(db);

    await expect(store.read('worker')).resolves.toBe('stored');
    await store.save('worker', 'next', 123);

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('on duplicate key update'),
      { worker: 'worker', afterId: 'next', now: 123 }
    );
  });

  it('starts from the beginning without a stored cursor', async () => {
    const store = storeWith({
      oneOrNull: jest.fn().mockResolvedValue(null),
      execute: jest.fn()
    });

    await expect(store.read('worker')).resolves.toBe('');
  });

  it('keeps rotating in memory while the table is missing', async () => {
    const db = {
      oneOrNull: jest.fn().mockRejectedValue(missingTable),
      execute: jest.fn().mockRejectedValue(missingTable)
    };
    const store = storeWith(db);

    await expect(store.read('worker')).resolves.toBe('');
    await store.save('worker', 'in-memory', 1);
    await expect(store.read('worker')).resolves.toBe('in-memory');
    // The missing table is not queried again on every call.
    expect(db.oneOrNull).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('never fails a pass when the cursor cannot be saved', async () => {
    const db = {
      oneOrNull: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockRejectedValue(new Error('lock wait timeout'))
    };
    const store = storeWith(db);

    await expect(store.save('worker', 'x', 1)).resolves.toBeUndefined();
    await expect(store.read('worker')).resolves.toBe('x');
  });
});
