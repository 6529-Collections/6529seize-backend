import {
  isRetryableDbLockError,
  withNextgenDbLockRetry
} from './nextgen-db-lock-retry';

describe('nextgen db lock retry', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('identifies retryable MySQL lock errors', () => {
    expect(isRetryableDbLockError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    expect(isRetryableDbLockError({ errno: 1205 })).toBe(true);
    expect(
      isRetryableDbLockError({
        driverError: { code: 'ER_LOCK_WAIT_TIMEOUT' }
      })
    ).toBe(true);
    expect(
      isRetryableDbLockError({
        driverError: {
          cause: {
            cause: { errno: 1213 }
          }
        }
      })
    ).toBe(true);
    expect(
      isRetryableDbLockError(
        new Error('Deadlock found when trying to get lock; try restarting')
      )
    ).toBe(true);
    expect(isRetryableDbLockError({ code: 'ER_PARSE_ERROR' })).toBe(false);
  });

  it('retries retryable failures and returns the successful result', async () => {
    const logger = { warn: jest.fn() };
    const sleep = jest
      .fn<Promise<void>, [number]>()
      .mockResolvedValue(undefined);
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce({ code: 'ER_LOCK_DEADLOCK' })
      .mockResolvedValue('ok');

    await expect(
      withNextgenDbLockRetry(operation, {
        logger,
        operation: 'test',
        sleep
      })
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not retry non-lock failures', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValue({ code: 'ER_PARSE_ERROR' });

    await expect(
      withNextgenDbLockRetry(operation, { operation: 'test' })
    ).rejects.toMatchObject({ code: 'ER_PARSE_ERROR' });

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
