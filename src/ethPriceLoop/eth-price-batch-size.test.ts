const mockRedis = { isReady: true, get: jest.fn(), set: jest.fn() };
jest.mock('@/redis', () => ({ getRedisClient: () => mockRedis }));
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { getHistoryChunkMs, shrinkHistoryChunk } from './eth-price-batch-size';
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
    first + HISTORY_CHUNK_MS - PRICE_INTERVAL_MS
  );
  expect(mockRedis.set).toHaveBeenCalledWith(
    ethPriceStateKey('batch-size'),
    String(HISTORY_CHUNK_MS / 2)
  );
  expect(await getHistoryChunkMs()).toBe(HISTORY_CHUNK_MS / 2);
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

it.each(['NaN', '0', '-1', '300001', String(2 * HISTORY_CHUNK_MS)])(
  'ignores invalid saved size %s',
  async (raw) => {
    mockRedis.get.mockResolvedValue(raw);
    expect(await getHistoryChunkMs()).toBe(HISTORY_CHUNK_MS);
  }
);
