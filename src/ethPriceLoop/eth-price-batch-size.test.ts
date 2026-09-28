const mockRedis = { isReady: true, get: jest.fn(), set: jest.fn() };
jest.mock('@/redis', () => ({ getRedisClient: () => mockRedis }));
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import {
  getHistoryChunkMs,
  growHistoryChunk,
  shrinkHistoryChunk,
  MAX_REPAIR_CHUNK_MS
} from './eth-price-batch-size';
import { HISTORY_CHUNK_MS, PRICE_INTERVAL_MS } from './coinbase';
import { ethPriceStateKey } from './eth-price-state-key';

const first = Date.UTC(2026, 8, 26);
const timeout = () =>
  new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'WORK',
    'NOT_SENT'
  );
beforeEach(async () => {
  jest.clearAllMocks();
  mockRedis.isReady = true;
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  await getHistoryChunkMs();
  await getHistoryChunkMs();
  jest.clearAllMocks();
});

it('halves failed work and reloads the durable size on the next invocation', async () => {
  let saved: string | null = null;
  mockRedis.get.mockImplementation(async () => saved);
  mockRedis.set.mockImplementation(async (_key, value) => {
    saved = value;
  });
  await shrinkHistoryChunk(
    timeout(),
    first,
    first + MAX_REPAIR_CHUNK_MS - PRICE_INTERVAL_MS
  );
  expect(mockRedis.set).toHaveBeenCalledWith(
    ethPriceStateKey('batch-size'),
    String(MAX_REPAIR_CHUNK_MS / 2)
  );
  expect(await getHistoryChunkMs()).toBe(MAX_REPAIR_CHUNK_MS / 2);
  await shrinkHistoryChunk(timeout(), first, first + 2 * PRICE_INTERVAL_MS);
  expect(await getHistoryChunkMs()).toBe(PRICE_INTERVAL_MS);
  await shrinkHistoryChunk(timeout(), first, first);
  expect(mockRedis.set).toHaveBeenCalledTimes(2);
});

it.each([
  new Error('query failed'),
  new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'ACQUIRE',
    'NOT_SENT'
  ),
  new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'COMMIT',
    'UNKNOWN'
  ),
  new SqlExecutionBudgetExceededError(
    'SQL_STATEMENT_FAILED',
    'WORK',
    'NOT_SENT',
    'ER_LOCK_DEADLOCK'
  )
])(
  'does not shrink for failures unrelated to the repair work budget: %s',
  async (error) => {
    await shrinkHistoryChunk(error, first, first + HISTORY_CHUNK_MS);
    expect(mockRedis.set).not.toHaveBeenCalled();
  }
);

it('keeps the reduced size locally if Redis persistence fails', async () => {
  mockRedis.set.mockRejectedValue(new Error('disconnected'));
  await shrinkHistoryChunk(timeout(), first, first + PRICE_INTERVAL_MS);
  mockRedis.isReady = false;
  expect(await getHistoryChunkMs()).toBe(PRICE_INTERVAL_MS);
});

it.each([null, String(HISTORY_CHUNK_MS)])(
  'keeps a pending reduction ahead of stale Redis value %s and retries persistence',
  async (raw) => {
    mockRedis.set.mockRejectedValue(new Error('write failed'));
    await shrinkHistoryChunk(timeout(), first, first + PRICE_INTERVAL_MS);
    mockRedis.get.mockResolvedValue(raw);
    expect(await getHistoryChunkMs()).toBe(PRICE_INTERVAL_MS);
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    mockRedis.set.mockResolvedValue('OK');
    expect(await getHistoryChunkMs()).toBe(PRICE_INTERVAL_MS);
    expect(mockRedis.set).toHaveBeenLastCalledWith(
      ethPriceStateKey('batch-size'),
      String(PRICE_INTERVAL_MS)
    );
    // Once the pending write is acknowledged, operator deletion is authoritative.
    mockRedis.get.mockResolvedValue(null);
    expect(await getHistoryChunkMs()).toBe(MAX_REPAIR_CHUNK_MS);
  }
);

it('flushes a reduction learned while disconnected before accepting remote state', async () => {
  mockRedis.isReady = false;
  await shrinkHistoryChunk(timeout(), first, first + PRICE_INTERVAL_MS);
  expect(mockRedis.set).not.toHaveBeenCalled();
  mockRedis.isReady = true;
  expect(await getHistoryChunkMs()).toBe(PRICE_INTERVAL_MS);
  expect(mockRedis.set).toHaveBeenCalledTimes(1);
  expect(mockRedis.get).not.toHaveBeenCalled();
});

it.each(['NaN', '0', '-1', '300001', String(2 * HISTORY_CHUNK_MS)])(
  'ignores invalid saved size %s',
  async (raw) => {
    mockRedis.get.mockResolvedValue(raw);
    expect(await getHistoryChunkMs()).toBe(MAX_REPAIR_CHUNK_MS);
  }
);

it.each([6 * 3600_000, 12 * 3600_000, HISTORY_CHUNK_MS])(
  'caps an older persisted repair size of %s to one hour',
  async (saved) => {
    mockRedis.get.mockResolvedValue(String(saved));
    expect(await getHistoryChunkMs()).toBe(MAX_REPAIR_CHUNK_MS);
  }
);

it('retains a smaller persisted window', async () => {
  mockRedis.get.mockResolvedValue(String(2 * PRICE_INTERVAL_MS));
  expect(await getHistoryChunkMs()).toBe(2 * PRICE_INTERVAL_MS);
});

it('grows a learned window gradually and persists it without exceeding one hour', async () => {
  expect(await growHistoryChunk(PRICE_INTERVAL_MS)).toBe(2 * PRICE_INTERVAL_MS);
  expect(mockRedis.set).toHaveBeenLastCalledWith(
    ethPriceStateKey('batch-size'),
    String(2 * PRICE_INTERVAL_MS)
  );
  expect(await growHistoryChunk(40 * 60_000)).toBe(MAX_REPAIR_CHUNK_MS);
  mockRedis.set.mockClear();
  expect(await growHistoryChunk(MAX_REPAIR_CHUNK_MS)).toBe(MAX_REPAIR_CHUNK_MS);
  expect(mockRedis.set).not.toHaveBeenCalled();
});

it('retains successful growth during a Redis outage and lets a later failure shrink it', async () => {
  mockRedis.set.mockRejectedValue(new Error('disconnected'));
  await growHistoryChunk(PRICE_INTERVAL_MS);
  expect(await getHistoryChunkMs()).toBe(2 * PRICE_INTERVAL_MS);
  await shrinkHistoryChunk(timeout(), first, first + PRICE_INTERVAL_MS);
  expect(await getHistoryChunkMs()).toBe(PRICE_INTERVAL_MS);
});
