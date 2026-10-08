import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { Logger } from '@/logging';
import { evictSubscriptionCacheBatch } from './subscription-cache-eviction';
import {
  invalidateUpcomingSubscriptionCaches,
  retryPendingSubscriptionCacheInvalidations
} from './subscription-cache';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { execute: jest.fn(), bulkInsert: jest.fn() }
}));
jest.mock('./subscription-cache-eviction', () => ({
  evictSubscriptionCacheBatch: jest.fn()
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      errorWithDiagnostic: jest.fn()
    }))
  }
}));
const evict = jest.mocked(evictSubscriptionCacheBatch);
const execute = jest.mocked(sqlExecutor.execute);
const insert = jest.mocked(sqlExecutor.bulkInsert);
const logger = jest.mocked(Logger.get).mock.results[0].value as Logger;
const timeout = Object.assign(new Error('Redis deadline exceeded'), {
  name: 'TimeoutError'
});

beforeEach(() => {
  jest.clearAllMocks();
  evict
    .mockReset()
    .mockResolvedValue({ scanned: 10, deleted: 3, elapsed_ms: 1 });
  execute.mockReset().mockResolvedValue([]);
  insert.mockReset().mockResolvedValue(undefined);
  jest.spyOn(Time.prototype, 'sleep').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('persists deduplicated requests before a single eviction and acknowledges only captured IDs', async () => {
  const keys = Array.from({ length: 1200 }, (_, i) => `wallet-${i}`);
  await invalidateUpcomingSubscriptionCaches([...keys, keys[0]]);
  const rows = insert.mock.calls[0][1];
  expect(rows.map((row) => JSON.parse(row.consolidation_keys).length)).toEqual([
    500, 500, 200
  ]);
  expect(evict).toHaveBeenCalledTimes(1);
  expect(evict).toHaveBeenCalledWith(keys);
  expect(insert.mock.invocationCallOrder[0]).toBeLessThan(
    evict.mock.invocationCallOrder[0]
  );
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM'),
    { ids: rows.map((row) => row.id) },
    { forcePool: 'WRITE' }
  );
});

it('does no bookkeeping for an empty change set', async () => {
  await invalidateUpcomingSubscriptionCaches([]);
  expect(insert).not.toHaveBeenCalled();
  expect(evict).not.toHaveBeenCalled();
});

it('retains failed work and reports one amber diagnostic with the actual error', async () => {
  evict.mockRejectedValue(timeout);
  await expect(
    invalidateUpcomingSubscriptionCaches(['auto'])
  ).resolves.toBeUndefined();
  expect(
    execute.mock.calls.every(([sql]) => !sql.includes('DELETE FROM'))
  ).toBe(true);
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining('attempts = attempts + 1'),
    expect.objectContaining({
      description: 'TimeoutError: Redis deadline exceeded'
    }),
    { forcePool: 'WRITE' }
  );
  expect(logger.errorWithDiagnostic).toHaveBeenCalledTimes(1);
  expect(logger.errorWithDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      category: 'TIMEOUT',
      recovery: expect.objectContaining({ state: 'pending', attempt: 1 })
    }),
    expect.any(String),
    expect.objectContaining({ retry_recorded: true })
  );
});

it('drains durable requests independently of a balance change, merging JSON and parsed rows', async () => {
  execute.mockResolvedValueOnce([
    { id: 'old-1', consolidation_keys: '["auto"]', attempts: 1 },
    { id: 'old-2', consolidation_keys: ['other'], attempts: 0 }
  ]);
  await retryPendingSubscriptionCacheInvalidations();
  expect(evict).toHaveBeenCalledWith(['auto', 'other']);
  expect(execute.mock.calls[0][2]).toEqual({ forcePool: 'WRITE' });
  expect(execute.mock.calls[1][1]).toEqual({ ids: ['old-1', 'old-2'] });
});

it('escalates persistent failures to red while retaining retry work', async () => {
  execute.mockResolvedValueOnce([
    { id: 'old', consolidation_keys: ['auto'], attempts: 2 }
  ]);
  evict.mockRejectedValue(timeout);
  await retryPendingSubscriptionCacheInvalidations();
  expect(logger.errorWithDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      recovery: expect.objectContaining({ state: 'unknown', attempt: 3 })
    }),
    expect.any(String),
    expect.objectContaining({ retry_recorded: true })
  );
  expect(execute.mock.calls[1][0]).toContain('UPDATE');
});

it('does not advertise recovery when retry persistence fails or the error is unclassified', async () => {
  insert.mockRejectedValue(new Error('DB unavailable'));
  evict.mockRejectedValue(timeout);
  await invalidateUpcomingSubscriptionCaches(['auto']);
  expect(logger.errorWithDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      recovery: expect.objectContaining({ state: 'unknown' })
    }),
    expect.any(String),
    expect.objectContaining({ retry_recorded: false })
  );
  insert.mockResolvedValue(undefined);
  evict.mockRejectedValue(new Error('WRONGPASS'));
  await invalidateUpcomingSubscriptionCaches(['auto']);
  expect(
    jest.mocked(logger.errorWithDiagnostic).mock.calls[1][0].recovery?.state
  ).toBe('unknown');
});

it('retries eviction if acknowledgement fails instead of losing the request', async () => {
  execute.mockRejectedValueOnce(new Error('ack failed')).mockResolvedValue([]);
  await invalidateUpcomingSubscriptionCaches(['auto']);
  expect(execute.mock.calls[1][0]).toContain('UPDATE');
});
