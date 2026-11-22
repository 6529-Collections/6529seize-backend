import { MAX_BATCHES } from './types';
import { updateUntilCaughtUp } from './wallet-transfer-rebuild';

function call(forward: number, reconciled = false) {
  return {
    refreshed_buckets: [
      ...(reconciled ? [{ reconciled: true }] : []),
      ...Array.from({ length: forward }, () => ({ reconciled: false }))
    ]
  };
}

describe('updateUntilCaughtUp', () => {
  it('calls update until a call moves forward fewer buckets than it may', async () => {
    const update = jest
      .fn()
      .mockResolvedValueOnce(call(MAX_BATCHES))
      .mockResolvedValueOnce(call(MAX_BATCHES, true))
      .mockResolvedValueOnce(call(3, true));

    await expect(updateUntilCaughtUp({ update } as never)).resolves.toBe(
      2 * MAX_BATCHES + 3
    );
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledWith({
      maxBatches: MAX_BATCHES,
      maxRows: 100_000
    });
  });

  it('stops after one call when there is nothing to summarise', async () => {
    const update = jest.fn().mockResolvedValue(call(0));
    await expect(updateUntilCaughtUp({ update } as never)).resolves.toBe(0);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
