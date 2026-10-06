import { evictRedisCacheForPathWithTimeout } from '@/redis';
import { Time } from '@/time';
import { invalidateUpcomingSubscriptionCaches } from './subscription-cache';

jest.mock('@/redis', () => ({ evictRedisCacheForPathWithTimeout: jest.fn() }));

const evict = jest.mocked(evictRedisCacheForPathWithTimeout);

beforeEach(() => {
  evict.mockReset().mockResolvedValue({ success: true, elapsed_ms: 0 });
  jest.spyOn(Time.prototype, 'sleep').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('invalidates quantities, eligibility, status and aggregates for changed profiles, including query variants', async () => {
  await invalidateUpcomingSubscriptionCaches(['auto', 'auto', 'other']);
  expect(evict.mock.calls.map(([args]) => args.path)).toEqual([
    '/api/subscriptions/upcoming-memes-counts',
    '/api/subscriptions/memes/*/count',
    '/api/subscriptions/consolidation/details/auto',
    '/api/subscriptions/consolidation/upcoming-memes/auto',
    '/api/subscriptions/consolidation/upcoming-memes/*/auto',
    '/api/subscriptions/consolidation/details/other',
    '/api/subscriptions/consolidation/upcoming-memes/other',
    '/api/subscriptions/consolidation/upcoming-memes/*/other'
  ]);
  expect(Time.prototype.sleep).toHaveBeenCalledTimes(1);
  expect(evict.mock.calls.every(([args]) => args.singleKeyDeletes)).toBe(true);
  expect(
    jest.mocked(Time.prototype.sleep).mock.invocationCallOrder[0]
  ).toBeLessThan(evict.mock.invocationCallOrder[0]);
});

it('does not scan Redis when no automatic quantities changed', async () => {
  await invalidateUpcomingSubscriptionCaches([]);
  expect(evict).not.toHaveBeenCalled();
});

it('continues invalidating the other paths after an eviction failure', async () => {
  evict.mockResolvedValueOnce({
    success: false,
    elapsed_ms: 1,
    error: new Error('Redis unavailable')
  });
  await expect(
    invalidateUpcomingSubscriptionCaches(['auto'])
  ).resolves.toBeUndefined();
  expect(evict).toHaveBeenCalledTimes(5);
});
