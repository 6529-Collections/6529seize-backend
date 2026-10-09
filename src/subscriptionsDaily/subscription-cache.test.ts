import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { Logger } from '@/logging';
import {
  evictSubscriptionCacheBatch,
  SubscriptionCacheEvictionError
} from './subscription-cache-eviction';
import {
  invalidateUpcomingSubscriptionCaches,
  retryPendingSubscriptionCacheInvalidations
} from './subscription-cache';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { execute: jest.fn(), bulkInsert: jest.fn() }
}));
jest.mock('./subscription-cache-eviction', () => ({
  ...jest.requireActual('./subscription-cache-eviction'),
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
  evict.mockReset().mockResolvedValue({
    scanned: 10,
    deleted: 3,
    elapsed_ms: 1,
    complete: true,
    cursor: '0'
  });
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
  expect(evict).toHaveBeenCalledWith(keys, '0');
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
    { id: 'old-2', consolidation_keys: ['other'], attempts: 1 }
  ]);
  await retryPendingSubscriptionCacheInvalidations();
  expect(evict).toHaveBeenCalledWith(['auto', 'other'], '0');
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
  expect(execute).toHaveBeenCalledTimes(1);
  expect(logger.errorWithDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'SUBSCRIPTION_CACHE_BOOKKEEPING' }),
    expect.any(String),
    expect.any(Object)
  );
});

it('keeps fresh and repeatedly failing requests in separate recovery groups', async () => {
  execute.mockResolvedValueOnce([
    { id: 'old', consolidation_keys: ['old'], attempts: 2, scan_cursor: '0' },
    {
      id: 'fresh',
      consolidation_keys: ['fresh'],
      attempts: 0,
      scan_cursor: '0'
    }
  ]);
  evict.mockRejectedValue(timeout);
  await retryPendingSubscriptionCacheInvalidations();
  const calls = jest.mocked(logger.errorWithDiagnostic).mock.calls;
  expect(calls.map(([diagnostic]) => diagnostic.recovery?.state)).toEqual([
    'unknown',
    'pending'
  ]);
  expect(execute.mock.calls.slice(1).map(([, params]) => params?.ids)).toEqual([
    ['old'],
    ['fresh']
  ]);
});

it('parks malformed requests while evicting valid siblings', async () => {
  execute.mockResolvedValueOnce([
    { id: 'poison', consolidation_keys: '{bad', attempts: 0 },
    { id: 'healthy', consolidation_keys: ['auto'], attempts: 0 }
  ]);
  await retryPendingSubscriptionCacheInvalidations();
  expect(execute.mock.calls[0][0]).toContain('parked = 0');
  expect(execute.mock.calls[1][0]).toContain('parked = 1');
  expect(evict).toHaveBeenCalledWith(['auto'], '0');
  expect(execute.mock.calls[2][1]).toEqual({ ids: ['healthy'] });
});

it('checkpoints healthy continuation without incrementing failures or deleting durable requests', async () => {
  execute.mockResolvedValueOnce([
    {
      id: 'resume',
      consolidation_keys: ['auto'],
      attempts: 0,
      scan_cursor: '18446744073709551610'
    }
  ]);
  evict.mockResolvedValue({
    scanned: 1000,
    deleted: 20,
    elapsed_ms: 1500,
    complete: false,
    cursor: '42'
  });
  await retryPendingSubscriptionCacheInvalidations();
  expect(evict).toHaveBeenCalledWith(['auto'], '18446744073709551610');
  expect(execute.mock.calls[1][0]).toContain('SET scan_cursor = :cursor');
  expect(execute.mock.calls[1][0]).not.toContain('attempts =');
  expect(execute.mock.calls[1][1]).toEqual(
    expect.objectContaining({ ids: ['resume'], cursor: '42' })
  );
  expect(logger.errorWithDiagnostic).not.toHaveBeenCalled();
});

it('preserves the last fully processed page after a later command failure', async () => {
  evict.mockRejectedValue(new SubscriptionCacheEvictionError(timeout, '42'));
  await invalidateUpcomingSubscriptionCaches(['auto']);
  expect(execute.mock.calls[0][1]).toEqual(
    expect.objectContaining({ cursor: '42' })
  );
});

it('continues healthy siblings and later groups when parking a malformed row fails', async () => {
  execute
    .mockResolvedValueOnce([
      { id: 'poison', consolidation_keys: '{bad', attempts: 0 },
      { id: 'healthy', consolidation_keys: ['auto'], attempts: 0 },
      { id: 'later', consolidation_keys: ['other'], attempts: 1 }
    ])
    .mockRejectedValueOnce(new Error('park write failed'))
    .mockResolvedValue([]);
  await retryPendingSubscriptionCacheInvalidations();
  expect(evict.mock.calls).toEqual([
    [['auto'], '0'],
    [['other'], '0']
  ]);
  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Could not park'),
    expect.objectContaining({ id: 'poison' })
  );
  expect(execute.mock.calls.slice(2).map(([, params]) => params?.ids)).toEqual([
    ['healthy'],
    ['later']
  ]);
});

it('reports checkpoint failure separately without incrementing eviction attempts or recording a stale cursor', async () => {
  execute
    .mockResolvedValueOnce([
      {
        id: 'resume',
        consolidation_keys: ['auto'],
        attempts: 0,
        scan_cursor: '42'
      }
    ])
    .mockRejectedValueOnce(new Error('checkpoint write failed'));
  evict.mockResolvedValue({
    scanned: 10,
    deleted: 2,
    elapsed_ms: 1500,
    complete: false,
    cursor: '84'
  });
  await retryPendingSubscriptionCacheInvalidations();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1][1]).toEqual(
    expect.objectContaining({ cursor: '84' })
  );
  expect(execute.mock.calls.every(([sql]) => !sql.includes('attempts ='))).toBe(
    true
  );
  expect(logger.errorWithDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'SUBSCRIPTION_CACHE_BOOKKEEPING' }),
    expect.any(String),
    expect.objectContaining({ completed_cursor: '84' })
  );
});

it('makes healthy continuation eligible immediately rather than applying failure backoff', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1000);
  evict.mockResolvedValue({
    scanned: 10,
    deleted: 2,
    elapsed_ms: 1500,
    complete: false,
    cursor: '42'
  });
  await invalidateUpcomingSubscriptionCaches(['auto']);
  expect(execute.mock.calls[0][1]).toEqual(
    expect.objectContaining({ nextAttempt: 1000 })
  );
});
