jest.mock('@/redis', () => ({
  getRedisClient: jest.fn()
}));

import { getRedisClient } from '@/redis';
import { RedisCiPipelineAlertTargetStore } from './ci-pipeline-alert-target.store';

const identity = {
  repo: '6529seize-frontend',
  environment: 'staging' as const,
  runId: '791'
};

const target = {
  dropId: 'deploy-drop',
  dropPartId: 7,
  sha: 'a'.repeat(40),
  triggeredByGithubLogin: 'prxt6529'
};

describe('RedisCiPipelineAlertTargetStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('indexes a deploy drop by deployment run identity', async () => {
    const values = new Map<string, string>();
    const redis = {
      set: jest.fn(async (key: string, value: string, _options: unknown) => {
        values.set(key, value);
        return 'OK';
      }),
      get: jest.fn(async (key: string) => values.get(key) ?? null)
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();

    await store.rememberDeployTarget(identity, target);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const writtenKeys = redis.set.mock.calls.map(([key]) => key);
    expect(new Set(writtenKeys).size).toBe(1);
    for (const [, value, options] of redis.set.mock.calls) {
      expect(JSON.parse(value)).toEqual(target);
      expect(options).toEqual({ EX: 30 * 24 * 60 * 60 });
    }

    await expect(store.resolveDeployTarget(identity)).resolves.toEqual(target);
    expect(redis.get.mock.calls.map(([key]) => key)).toEqual(writtenKeys);

    await expect(
      store.resolveDeployTarget({ ...identity, runId: 'different-run' })
    ).resolves.toBeNull();
  });

  it('ignores malformed cached correlation data', async () => {
    const redis = {
      get: jest
        .fn()
        .mockResolvedValue(JSON.stringify({ ...target, dropId: '' }))
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();
    await expect(store.resolveDeployTarget(identity)).resolves.toBeNull();
  });

  it('does not query Redis when no correlation identity is supplied', async () => {
    const redis = { get: jest.fn() };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();

    await expect(
      store.resolveDeployTarget({
        repo: identity.repo,
        environment: identity.environment
      })
    ).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('falls back to a standalone post when Redis is unavailable', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const store = new RedisCiPipelineAlertTargetStore();

    await expect(store.resolveDeployTarget(identity)).resolves.toBeNull();
  });

  it('falls back to a standalone post when Redis lookup fails', async () => {
    const redis = { get: jest.fn().mockRejectedValue(new Error('offline')) };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();

    await expect(store.resolveDeployTarget(identity)).resolves.toBeNull();
  });
});
