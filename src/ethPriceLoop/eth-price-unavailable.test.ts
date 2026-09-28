const mockRedis = { isReady: true, get: jest.fn(), set: jest.fn() };
jest.mock('@/redis', () => ({ getRedisClient: () => mockRedis }));
import {
  deferMissingPrices,
  getUnavailablePrices
} from './eth-price-unavailable';
import { ethPriceStateKey } from './eth-price-state-key';
const now = Date.UTC(2026, 8, 28, 12);
const step = 300_000;
const day = 86400_000;
const price = (timestamp_ms: number) => ({
  timestamp_ms,
  date: new Date(timestamp_ms),
  usd_price: 2600
});
beforeEach(async () => {
  jest.clearAllMocks();
  mockRedis.isReady = true;
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  await getUnavailablePrices(now);
  await getUnavailablePrices(now);
  jest.clearAllMocks();
});
it('records only contiguous missing closes and expires their retry cooldown', async () => {
  await deferMissingPrices(
    [price(now - 3 * step), price(now)],
    now - 3 * step,
    now,
    now
  );
  const ranges = [
    { first: now - 2 * step, last: now - step, retryAt: now + day }
  ];
  expect(mockRedis.set).toHaveBeenLastCalledWith(
    ethPriceStateKey('unavailable'),
    JSON.stringify(ranges),
    { PX: day }
  );
  mockRedis.get.mockResolvedValue(JSON.stringify(ranges));
  expect(await getUnavailablePrices(now)).toEqual(ranges);
  expect(await getUnavailablePrices(now + day)).toEqual([]);
});
it('does not add retry state when all candles exist', async () => {
  await deferMissingPrices([price(now)], now, now, now);
  expect(mockRedis.set).not.toHaveBeenCalled();
});
it('keeps a warm-process cooldown during Redis outages without failing collection', async () => {
  mockRedis.isReady = false;
  await deferMissingPrices([], now - step, now, now);
  expect(await getUnavailablePrices(now)).toEqual([
    { first: now - step, last: now, retryAt: now + day }
  ]);
});
it('retains cooldown locally after failed persistence', async () => {
  mockRedis.set.mockRejectedValue(new Error('disconnect'));
  await deferMissingPrices([], now, now, now);
  mockRedis.get.mockRejectedValue(new Error('disconnect'));
  expect(await getUnavailablePrices(now)).toEqual([
    { first: now, last: now, retryAt: now + day }
  ]);
});

it.each([null, '[]'])(
  'keeps unpersisted cooldowns ahead of stale Redis value %s and flushes them',
  async (raw) => {
    mockRedis.set.mockRejectedValue(new Error('write failed'));
    await deferMissingPrices([], now, now, now);
    mockRedis.get.mockClear().mockResolvedValue(raw);
    const ranges = [{ first: now, last: now, retryAt: now + day }];
    expect(await getUnavailablePrices(now)).toEqual(ranges);
    expect(mockRedis.get).not.toHaveBeenCalled();
    mockRedis.set.mockResolvedValue('OK');
    expect(await getUnavailablePrices(now)).toEqual(ranges);
    expect(mockRedis.set).toHaveBeenLastCalledWith(
      ethPriceStateKey('unavailable'),
      JSON.stringify(ranges),
      { PX: day }
    );
    // Successful persistence restores normal authoritative empty reads.
    expect(await getUnavailablePrices(now)).toEqual([]);
  }
);

it('keeps an older saved cooldown together with a newly pending one', async () => {
  const old = { first: now - step, last: now - step, retryAt: now + day };
  mockRedis.get.mockResolvedValue(JSON.stringify([old]));
  mockRedis.set.mockRejectedValue(new Error('write failed'));
  await deferMissingPrices([], now, now, now);
  expect(await getUnavailablePrices(now)).toEqual([
    old,
    { first: now, last: now, retryAt: now + day }
  ]);
});

it('expires pending cooldowns without extending their retry times on reconnect', async () => {
  mockRedis.isReady = false;
  await deferMissingPrices([], now, now, now);
  mockRedis.isReady = true;
  expect(await getUnavailablePrices(now + day)).toEqual([]);
  expect(mockRedis.set).toHaveBeenLastCalledWith(
    ethPriceStateKey('unavailable'),
    '[]',
    { PX: day }
  );
});
it('rejects invalid state without hiding database gaps', async () => {
  mockRedis.get.mockResolvedValue(
    '[{"first":1,"last":2,"retryAt":9999999999999}]'
  );
  expect(await getUnavailablePrices(now)).toEqual([]);
});
it('isolates deployment keys even when database identifiers match', () => {
  const original = process.env.SENTRY_ENVIRONMENT;
  try {
    process.env.SENTRY_ENVIRONMENT = 'ethPriceLoop_staging';
    const staging = ethPriceStateKey('reset');
    process.env.SENTRY_ENVIRONMENT = 'ethPriceLoop_prod';
    expect(ethPriceStateKey('reset')).not.toBe(staging);
  } finally {
    if (original === undefined) delete process.env.SENTRY_ENVIRONMENT;
    else process.env.SENTRY_ENVIRONMENT = original;
  }
});

it('keeps daily cooldowns separate from legacy five-minute omissions', async () => {
  const first = Date.UTC(2021, 9, 1);
  await deferMissingPrices(
    [price(first + day)],
    first,
    first + 2 * day,
    now,
    day
  );
  expect(mockRedis.set).toHaveBeenLastCalledWith(
    ethPriceStateKey('daily-unavailable'),
    JSON.stringify([
      { first, last: first, retryAt: now + day },
      { first: first + 2 * day, last: first + 2 * day, retryAt: now + day }
    ]),
    { PX: day }
  );
  mockRedis.get.mockClear();
  await getUnavailablePrices(now);
  expect(mockRedis.get).toHaveBeenCalledWith(ethPriceStateKey('unavailable'));
});
