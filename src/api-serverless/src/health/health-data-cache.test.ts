import {
  getCachedHealthData,
  HEALTH_DATA_CACHE_TTL_MS,
  HealthData,
  resetHealthDataCacheForTests
} from './health.service';

function payload(status: HealthData['status']): HealthData {
  return { status } as HealthData;
}

describe('getCachedHealthData', () => {
  beforeEach(() => {
    resetHealthDataCacheForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-10T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves one computation to every caller within the TTL', async () => {
    const load = jest.fn().mockResolvedValue(payload('ok'));

    await getCachedHealthData(load);
    jest.setSystemTime(Date.now() + HEALTH_DATA_CACHE_TTL_MS - 1);
    await expect(getCachedHealthData(load)).resolves.toEqual(payload('ok'));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('recomputes after the TTL', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(payload('ok'))
      .mockResolvedValueOnce(payload('degraded'));

    await getCachedHealthData(load);
    jest.setSystemTime(Date.now() + HEALTH_DATA_CACHE_TTL_MS + 1);

    await expect(getCachedHealthData(load)).resolves.toEqual(
      payload('degraded')
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight computation between concurrent callers', async () => {
    let resolveLoad: (data: HealthData) => void = () => undefined;
    const load = jest.fn(
      () =>
        new Promise<HealthData>((resolve) => {
          resolveLoad = resolve;
        })
    );

    const first = getCachedHealthData(load);
    const second = getCachedHealthData(load);
    resolveLoad(payload('ok'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      payload('ok'),
      payload('ok')
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed computation', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(payload('ok'));

    await expect(getCachedHealthData(load)).rejects.toThrow('boom');
    await expect(getCachedHealthData(load)).resolves.toEqual(payload('ok'));
  });
});
