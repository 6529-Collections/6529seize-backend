import { createRetryableInitializer } from './app-initialization';

function setup({
  prepare = jest.fn().mockResolvedValue(undefined),
  wire = jest.fn()
}: {
  prepare?: jest.Mock;
  wire?: jest.Mock;
} = {}) {
  const onFailure = jest.fn();
  const ensureInitialized = createRetryableInitializer({
    prepare,
    wire,
    onFailure
  });
  return { ensureInitialized, prepare, wire, onFailure };
}

describe('createRetryableInitializer', () => {
  it('retries after a transient prepare failure and then succeeds', async () => {
    const transient = new Error('secrets timeout');
    const { ensureInitialized, prepare, wire, onFailure } = setup({
      prepare: jest
        .fn()
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce(undefined)
    });

    await expect(ensureInitialized()).rejects.toBe(transient);
    expect(onFailure).toHaveBeenCalledWith(transient);
    expect(wire).not.toHaveBeenCalled();

    await expect(ensureInitialized()).resolves.toBeUndefined();
    await expect(ensureInitialized()).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight attempt between concurrent callers', async () => {
    let finishPrepare: () => void = () => undefined;
    const { ensureInitialized, prepare, wire } = setup({
      prepare: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishPrepare = resolve;
          })
      )
    });

    const first = ensureInitialized();
    const second = ensureInitialized();
    finishPrepare();

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('never re-runs wiring after it failed part-way', async () => {
    const wiringError = new Error('route registration failed');
    const { ensureInitialized, prepare, wire, onFailure } = setup({
      wire: jest.fn(() => {
        throw wiringError;
      })
    });

    await expect(ensureInitialized()).rejects.toBe(wiringError);
    await expect(ensureInitialized()).rejects.toBe(wiringError);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
