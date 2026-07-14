import { ReleaseNoteGenerationRequest } from '@/release-notes/release-note-generation-queue';
import { parseReleaseNoteMessage, processRequest } from './index';

const request: ReleaseNoteGenerationRequest = {
  repo: '6529seize-backend',
  workflow: 'Deploy a service',
  run_id: '123',
  run_number: '45',
  run_url: 'https://github.com/example/actions/runs/123',
  sha: 'abc123',
  branch: 'main',
  environment: 'prod',
  service: 'api',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'backend-release',
  release_group_services: ['api', 'worker'],
  deployed_at: '2026-07-13T11:38:00.000Z'
};

describe('parseReleaseNoteMessage', () => {
  it('parses a valid message', () => {
    expect(
      parseReleaseNoteMessage(
        JSON.stringify({
          repo: '6529-Collections/6529seize-frontend',
          workflow: 'Web Deploy - PROD',
          run_id: '123',
          run_number: '45',
          run_url: 'https://github.com/example/actions/runs/123',
          sha: 'abc123',
          branch: 'main',
          environment: 'prod',
          service: 'web',
          prompt_path: 'ops/release-notes/release-notes.prompt.md',
          release_group_id: 'frontend-release',
          release_group_services: ['web'],
          deployed_at: '2026-07-13T11:38:00.000Z'
        })
      )
    ).toEqual({
      repo: '6529-Collections/6529seize-frontend',
      workflow: 'Web Deploy - PROD',
      run_id: '123',
      run_number: '45',
      run_url: 'https://github.com/example/actions/runs/123',
      sha: 'abc123',
      branch: 'main',
      environment: 'prod',
      service: 'web',
      prompt_path: 'ops/release-notes/release-notes.prompt.md',
      release_group_id: 'frontend-release',
      release_group_services: ['web'],
      deployed_at: '2026-07-13T11:38:00.000Z'
    });
  });

  it('rejects a missing prompt path', () => {
    expect(() =>
      parseReleaseNoteMessage(
        JSON.stringify({
          repo: '6529-Collections/6529seize-frontend',
          workflow: 'Web Deploy - PROD',
          run_id: '123',
          run_url: 'https://github.com/example/actions/runs/123',
          sha: 'abc123',
          environment: 'prod'
        })
      )
    ).toThrow('prompt_path is required');
  });

  it('rejects deployment dates without a full timestamp', () => {
    expect(() =>
      parseReleaseNoteMessage(
        JSON.stringify({
          ...request,
          deployed_at: '2026-07-13'
        })
      )
    ).toThrow('deployed_at must be a full ISO timestamp');
  });
});

describe('processRequest', () => {
  const workerRun = {
    service: 'worker',
    run_id: '456',
    run_number: '46',
    run_url: 'https://github.com/example/actions/runs/456'
  };

  function buildRedis(
    completedServices: string[] = [],
    storedValues: Record<string, string> = {}
  ) {
    const values = new Map(Object.entries(storedValues));
    return {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(values.get(key) ?? null)
        ),
      set: jest.fn().mockImplementation((key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve('OK');
      }),
      del: jest.fn().mockResolvedValue(1),
      sAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      sMembers: jest.fn().mockResolvedValue(completedServices)
    };
  }

  it('fails closed when Redis is unavailable', async () => {
    await expect(processRequest(request, { redis: null })).rejects.toThrow(
      'Redis is required to deduplicate release'
    );
  });

  it('checks deduplication before mutating group state', async () => {
    const redis = buildRedis();
    redis.get.mockResolvedValue('processed');
    const generateAndPost = jest.fn();

    await processRequest(request, {
      redis: redis as any,
      generateAndPost
    });

    expect(redis.sAdd).not.toHaveBeenCalled();
    expect(generateAndPost).not.toHaveBeenCalled();
  });

  it('waits until every grouped service succeeds', async () => {
    const redis = buildRedis(['api']);
    const generateAndPost = jest.fn();

    await processRequest(request, {
      redis: redis as any,
      generateAndPost
    });

    expect(redis.sAdd).toHaveBeenCalledWith(
      'release-note-group:backend-release:completed',
      'api'
    );
    expect(generateAndPost).not.toHaveBeenCalled();
  });

  it('locks, generates, records deduplication, and releases the lock', async () => {
    const redis = buildRedis(['api', 'worker'], {
      'release-note-group:backend-release:run:worker': JSON.stringify(workerRun)
    });
    const generateAndPost = jest.fn().mockResolvedValue(undefined);

    await processRequest(request, {
      redis: redis as any,
      generateAndPost
    });

    expect(generateAndPost).toHaveBeenCalledWith(
      {
        ...request,
        release_group_runs: [
          {
            service: 'api',
            run_id: '123',
            run_number: '45',
            run_url: 'https://github.com/example/actions/runs/123'
          },
          workerRun
        ]
      },
      {}
    );
    expect(redis.set).toHaveBeenCalledWith(
      'release-note-group:backend-release:run:api',
      JSON.stringify({
        service: 'api',
        run_id: '123',
        run_number: '45',
        run_url: 'https://github.com/example/actions/runs/123'
      }),
      { EX: 7776000 }
    );
    expect(redis.set).toHaveBeenCalledWith(
      'release-note:6529seize-backend:backend-release:abc123:processing',
      '1',
      { NX: true, EX: 1200 }
    );
    expect(redis.set).toHaveBeenCalledWith(
      'release-note:6529seize-backend:backend-release:abc123',
      '1',
      { EX: 7776000 }
    );
    expect(redis.del).toHaveBeenCalledWith(
      'release-note:6529seize-backend:backend-release:abc123:processing'
    );
  });

  it('sanitizes the deployed SHA in Redis keys', async () => {
    const redis = buildRedis(['api', 'worker'], {
      'release-note-group:backend-release:run:worker': JSON.stringify(workerRun)
    });

    await processRequest(
      { ...request, sha: 'abc:123' },
      {
        redis: redis as any,
        generateAndPost: jest.fn().mockResolvedValue(undefined)
      }
    );

    expect(redis.set).toHaveBeenCalledWith(
      'release-note:6529seize-backend:backend-release:abc-123:processing',
      '1',
      { NX: true, EX: 1200 }
    );
  });
});
