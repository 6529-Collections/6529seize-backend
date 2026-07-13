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
  function buildRedis(completedServices: string[] = []) {
    return {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
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
    const redis = buildRedis(['api', 'worker']);
    const generateAndPost = jest.fn().mockResolvedValue(undefined);

    await processRequest(request, {
      redis: redis as any,
      generateAndPost
    });

    expect(generateAndPost).toHaveBeenCalledWith(request, {});
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'release-note:6529seize-backend:backend-release:abc123:processing',
      '1',
      { NX: true, EX: 1200 }
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      'release-note:6529seize-backend:backend-release:abc123',
      '1',
      { EX: 7776000 }
    );
    expect(redis.del).toHaveBeenCalledWith(
      'release-note:6529seize-backend:backend-release:abc123:processing'
    );
  });
});
