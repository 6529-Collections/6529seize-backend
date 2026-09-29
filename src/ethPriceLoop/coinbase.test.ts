const mockGet = jest.fn();
const mockRetry = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ get: mockGet }) }
}));
jest.mock('axios-retry', () => ({
  __esModule: true,
  default: Object.assign(mockRetry, { isNetworkError: () => false })
}));
import {
  fetchHistoricPrices,
  fetchLivePrice,
  PRICE_INTERVAL_MS,
  DAILY_PRICE_INTERVAL_MS
} from './coinbase';
const now = Date.UTC(2026, 8, 28, 12);
beforeEach(() => mockGet.mockReset());
it('uses the ticker trade time and a positive USD price', async () => {
  mockGet.mockResolvedValue({
    data: { price: '2600.25', time: new Date(now - 1000).toISOString() }
  });
  expect(await fetchLivePrice(now)).toEqual({
    timestamp_ms: now - 1000,
    date: new Date(now - 1000),
    usd_price: 2600.25
  });
});
it.each([0, -1, 'NaN', null, {}, ''])(
  'rejects invalid ticker price %p',
  async (price) => {
    mockGet.mockResolvedValue({
      data: { price, time: new Date(now).toISOString() }
    });
    await expect(fetchLivePrice(now)).rejects.toThrow('Invalid Coinbase');
  }
);
it.each([now - 600_000, now + 60_000])(
  'rejects stale/future trades',
  async (time) => {
    mockGet.mockResolvedValue({
      data: { price: '2600', time: new Date(time).toISOString() }
    });
    await expect(fetchLivePrice(now)).rejects.toThrow('stale or future');
  }
);
it('sorts candles and maps close to interval end, filtering provider overfetch', async () => {
  mockGet.mockResolvedValue({
    data: [
      [now / 1000 - 300, 1, 3, 1, 2, 9],
      [now / 1000 - 900, 1, 3, 1, 3, 9],
      [now / 1000 - 600, 1, 3, 1, 1, 9],
      [now / 1000, 1, 3, 1, 3, 9]
    ]
  });
  expect(
    (await fetchHistoricPrices(now - PRICE_INTERVAL_MS, now, now)).map((p) => [
      p.timestamp_ms,
      p.usd_price
    ])
  ).toEqual([
    [now - PRICE_INTERVAL_MS, 1],
    [now, 2]
  ]);
  expect(mockGet).toHaveBeenCalledWith('/candles', {
    params: {
      granularity: 300,
      start: new Date(now - 600_000).toISOString(),
      end: new Date(now - 300_000).toISOString()
    }
  });
});
it('returns only actual candles when Coinbase omits an interval', async () => {
  mockGet.mockResolvedValue({ data: [[now / 1000 - 300, 1, 3, 1, 2, 9]] });
  expect(await fetchHistoricPrices(now - PRICE_INTERVAL_MS, now, now)).toEqual([
    { timestamp_ms: now, date: new Date(now), usd_price: 2 }
  ]);
});
it('rejects repeated candles', async () => {
  mockGet.mockResolvedValue({
    data: Array(2).fill([now / 1000 - 300, 1, 3, 1, 2, 9])
  });
  await expect(fetchHistoricPrices(now, now, now)).rejects.toThrow('Duplicate');
});
it('rejects oversized or unfinished ranges before requesting', async () => {
  await expect(
    fetchHistoricPrices(now - 300 * PRICE_INTERVAL_MS, now, now)
  ).rejects.toThrow('Invalid');
  await expect(
    fetchHistoricPrices(now, now + PRICE_INTERVAL_MS, now)
  ).rejects.toThrow('Invalid');
  expect(mockGet).not.toHaveBeenCalled();
});
it('bounds retries and retries only transient HTTP responses', () => {
  const config = mockRetry.mock.calls[0][1];
  expect(config.retries).toBe(3);
  expect(config.retryCondition({ response: { status: 429 } })).toBe(true);
  expect(config.retryCondition({ response: { status: 503 } })).toBe(true);
  expect(config.retryCondition({ response: { status: 401 } })).toBe(false);
  expect(config.retryDelay(10)).toBe(8000);
});

it('accepts an empty interval without fabricating a quote', async () => {
  mockGet.mockResolvedValue({ data: [] });
  expect(await fetchHistoricPrices(now, now, now)).toEqual([]);
});

it('uses a daily close at UTC midnight without assigning future-day data', async () => {
  const close = Date.UTC(2025, 11, 31);
  mockGet.mockResolvedValue({
    data: [[(close - DAILY_PRICE_INTERVAL_MS) / 1000, 1, 3, 1, 2, 9]]
  });
  expect(
    await fetchHistoricPrices(close, close, now, DAILY_PRICE_INTERVAL_MS)
  ).toEqual([{ timestamp_ms: close, date: new Date(close), usd_price: 2 }]);
  expect(mockGet).toHaveBeenCalledWith('/candles', {
    params: {
      granularity: 86400,
      start: new Date(close - DAILY_PRICE_INTERVAL_MS).toISOString(),
      end: new Date(close - DAILY_PRICE_INTERVAL_MS).toISOString()
    }
  });
});
it('rejects unsupported or misaligned daily requests', async () => {
  await expect(fetchHistoricPrices(now, now, now, 123)).rejects.toThrow(
    'Invalid'
  );
  await expect(
    fetchHistoricPrices(now, now, now, DAILY_PRICE_INTERVAL_MS)
  ).rejects.toThrow('Invalid');
  expect(mockGet).not.toHaveBeenCalled();
});
