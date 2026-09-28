const mockRedis = { isReady: true, get: jest.fn(), set: jest.fn() };
jest.mock('@/redis', () => ({ getRedisClient: () => mockRedis }));
import { getPriceReset, savePriceReset } from './eth-price-reset';
import { HISTORY_START_MS, PRICE_INTERVAL_MS } from './coinbase';
const originalHost = process.env.DB_HOST;
const originalName = process.env.DB_NAME;
afterEach(() => {
  process.env.DB_HOST = originalHost;
  process.env.DB_NAME = originalName;
});
const end = Date.UTC(2026, 8, 28);
beforeEach(() => {
  mockRedis.isReady = true;
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  process.env.DB_HOST = 'test-db';
  process.env.DB_NAME = 'test';
});
it('creates a fixed historical range without a TTL', async () => {
  const state = await getPriceReset(true, end);
  expect(state).toEqual({
    next: HISTORY_START_MS,
    end,
    latched: true
  });
  expect(mockRedis.set).toHaveBeenLastCalledWith(
    expect.stringContaining('test-db:test'),
    JSON.stringify(state)
  );
});
it('continues an unfinished reset after flag clears', async () => {
  mockRedis.get.mockResolvedValue(
    JSON.stringify({ next: end - PRICE_INTERVAL_MS, end, latched: true })
  );
  expect(await getPriceReset(false, end)).toEqual({
    next: end - PRICE_INTERVAL_MS,
    end,
    latched: false
  });
});
it('does not restart a completed reset while true remains set', async () => {
  const state = { next: end + PRICE_INTERVAL_MS, end, latched: true };
  mockRedis.get.mockResolvedValue(JSON.stringify(state));
  expect(await getPriceReset(true, end)).toEqual(state);
});
it('rearms only after a completed reset has seen false', async () => {
  mockRedis.get.mockResolvedValue(
    JSON.stringify({ next: end + PRICE_INTERVAL_MS, end, latched: false })
  );
  expect((await getPriceReset(true, end))?.next).toBe(HISTORY_START_MS);
});
it('requires Redis for reset but leaves ordinary recovery usable', async () => {
  mockRedis.isReady = false;
  expect(await getPriceReset(false, end)).toBeNull();
  await expect(getPriceReset(true, end)).rejects.toThrow('requires Redis');
  await expect(
    savePriceReset({ next: end, end, latched: true })
  ).rejects.toThrow('unavailable');
});
it('rejects corrupt checkpoints instead of skipping history', async () => {
  mockRedis.get.mockResolvedValue('{"next":1,"end":2,"latched":true}');
  await expect(getPriceReset(true, end)).rejects.toThrow('Invalid');
});

it.each(['{broken', 'null', 'false', '0', '[]', '"hello"', '{}'])(
  'rejects malformed checkpoint %s with the domain error',
  async (raw) => {
    mockRedis.get.mockResolvedValue(raw);
    await expect(getPriceReset(true, end)).rejects.toThrow(
      'Invalid ETH price reset checkpoint'
    );
  }
);

it('reloads a completed pre-2026 reset with a mid-day end without restarting it', async () => {
  const legacyEnd = Date.UTC(2025, 11, 31, 12, 5);
  const state = {
    next: legacyEnd + PRICE_INTERVAL_MS,
    end: legacyEnd,
    latched: true
  };
  mockRedis.get.mockResolvedValue(JSON.stringify(state));
  expect(await getPriceReset(true, end)).toEqual(state);
});
