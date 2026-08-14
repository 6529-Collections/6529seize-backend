jest.mock('@/redis', () => ({
  getRedisClient: jest.fn()
}));

import { getRedisClient } from '@/redis';
import { RedisCiPipelineAlertTargetStore } from './ci-pipeline-alert-target.store';

const identity = {
  repo: '6529seize-frontend',
  environment: 'staging' as const,
  runId: '791',
  releaseTrainId: 'train-123'
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

  it('indexes a deploy drop by run and Release Train identity', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK')
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();

    await store.rememberDeployTarget(identity, target);

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.set.mock.calls[0][0]).not.toBe(redis.set.mock.calls[1][0]);
    for (const [, value, options] of redis.set.mock.calls) {
      expect(JSON.parse(value)).toEqual(target);
      expect(options).toEqual({ EX: 30 * 24 * 60 * 60 });
    }
  });

  it('resolves only when every supplied identity points to the same drop', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify(target))
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();

    await expect(store.resolveDeployTarget(identity)).resolves.toEqual(target);
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  it('treats conflicting parent identities as ambiguous', async () => {
    const redis = {
      get: jest
        .fn()
        .mockResolvedValueOnce(JSON.stringify(target))
        .mockResolvedValueOnce(
          JSON.stringify({ ...target, dropId: 'different-drop' })
        )
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const store = new RedisCiPipelineAlertTargetStore();

    await expect(store.resolveDeployTarget(identity)).resolves.toBeNull();
  });

  it('falls back to a standalone post when identity is absent or Redis is unavailable', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const store = new RedisCiPipelineAlertTargetStore();

    await expect(
      store.resolveDeployTarget({
        repo: identity.repo,
        environment: identity.environment
      })
    ).resolves.toBeNull();
    await expect(store.resolveDeployTarget(identity)).resolves.toBeNull();
  });
});
