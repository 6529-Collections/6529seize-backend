import {
  saveTdhInBatches,
  TDH_SAVE_BATCH_SIZE
} from './tdh-persistence-batches';

describe('bounded TDH persistence', () => {
  const rows = Array.from({ length: TDH_SAVE_BATCH_SIZE * 2 + 1 }, (_, i) => ({
    wallet: `wallet-${i}`,
    tdh_rank: i + 1,
    memes_ranks: [{ id: 1, rank: i + 1 }]
  }));

  it('persists the entire ranking universe without overlapping saves', async () => {
    const saved: typeof rows = [];
    let active = 0;
    let maxActive = 0;
    const save = jest.fn(async (batch: typeof rows) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      saved.push(...batch);
      active--;
    });

    await saveTdhInBatches({ save }, rows);

    expect(maxActive).toBe(1);
    expect(save.mock.calls.map(([batch]) => batch.length)).toEqual([
      500, 500, 1
    ]);
    expect(saved).toEqual(rows);
    expect(saved[saved.length - 1]?.memes_ranks).toEqual([
      { id: 1, rank: rows.length }
    ]);
  });

  it('waits for a pending save before starting the next batch', async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const save = jest.fn().mockResolvedValue(undefined);
    save.mockImplementationOnce(() => first);

    const persistence = saveTdhInBatches({ save }, rows);
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    finishFirst();
    await persistence;
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('propagates a later failure and never starts remaining batches', async () => {
    const failure = new Error('second batch failed');
    const save = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);

    await expect(saveTdhInBatches({ save }, rows)).rejects.toBe(failure);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual(rows.slice(500, 1000));
  });

  it('does not issue a save for an empty dataset', async () => {
    const save = jest.fn();

    await saveTdhInBatches({ save }, []);

    expect(save).not.toHaveBeenCalled();
  });
});
