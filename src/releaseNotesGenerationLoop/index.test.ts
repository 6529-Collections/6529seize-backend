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
  pull_request_number: 1749,
  publish_release_note: false,
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
      pull_request_number: null,
      publish_release_note: false,
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

  it('rejects a non-boolean publish flag', () => {
    expect(() =>
      parseReleaseNoteMessage(
        JSON.stringify({ ...request, publish_release_note: 'true' })
      )
    ).toThrow('publish_release_note must be a boolean');
  });
});

describe('processRequest', () => {
  function buildRedis(storedValues: Record<string, string> = {}) {
    const values = new Map(Object.entries(storedValues));
    const sets = new Map<string, Set<string>>();
    return {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(values.get(key) ?? null)
        ),
      set: jest
        .fn()
        .mockImplementation(
          (key: string, value: string, options?: { NX?: boolean }) => {
            if (options?.NX && values.has(key)) {
              return Promise.resolve(null);
            }
            values.set(key, value);
            return Promise.resolve('OK');
          }
        ),
      del: jest.fn().mockResolvedValue(1),
      sAdd: jest.fn().mockImplementation((key: string, value: string) => {
        const members = sets.get(key) ?? new Set<string>();
        members.add(value);
        sets.set(key, members);
        return Promise.resolve(1);
      }),
      expire: jest.fn().mockResolvedValue(true),
      sMembers: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(Array.from(sets.get(key) ?? []))
        ),
      deleteValue: (key: string) => values.delete(key)
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

  it('accumulates a successful service without publishing when held', async () => {
    const redis = buildRedis();
    const generateAndPost = jest.fn();

    await processRequest(request, {
      redis: redis as any,
      generateAndPost
    });

    expect(redis.sAdd).toHaveBeenCalledWith(
      'release-note-group:6529seize-backend:pr-1749:services',
      'api'
    );
    expect(redis.set).toHaveBeenCalledWith(
      'release-note-group:6529seize-backend:pr-1749:run:api',
      expect.any(String),
      { EX: 7776000 }
    );
    expect(generateAndPost).not.toHaveBeenCalled();
  });

  it('publishes all successful PR services when the final deploy says publish', async () => {
    const redis = buildRedis();
    const generateAndPost = jest.fn().mockResolvedValue(undefined);

    await processRequest(request, { redis: redis as any, generateAndPost });

    await processRequest(
      {
        ...request,
        run_id: '456',
        run_number: '46',
        run_url: 'https://github.com/example/actions/runs/456',
        sha: 'later-sha',
        service: 'worker',
        release_group_services: ['worker'],
        publish_release_note: true
      },
      {
        redis: redis as any,
        generateAndPost
      }
    );

    expect(generateAndPost).toHaveBeenCalledWith(
      {
        ...request,
        run_id: '456',
        run_number: '46',
        run_url: 'https://github.com/example/actions/runs/456',
        sha: 'later-sha',
        service: 'worker',
        publish_release_note: true,
        release_group_services: ['api', 'worker'],
        release_group_runs: [
          {
            service: 'api',
            run_id: '123',
            run_number: '45',
            run_url: 'https://github.com/example/actions/runs/123'
          },
          {
            service: 'worker',
            run_id: '456',
            run_number: '46',
            run_url: 'https://github.com/example/actions/runs/456'
          }
        ]
      },
      {}
    );
    expect(generateAndPost).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'release-note-group:6529seize-backend:pr-1749:run:api',
      JSON.stringify({
        service: 'api',
        run_id: '123',
        run_number: '45',
        run_url: 'https://github.com/example/actions/runs/123'
      }),
      { EX: 7776000 }
    );
    expect(redis.set).toHaveBeenCalledWith(
      'release-note:6529seize-backend:pr-1749:processing',
      '1',
      { NX: true, EX: 1200 }
    );
    expect(redis.set).toHaveBeenCalledWith(
      'release-note:6529seize-backend:pr-1749',
      '1',
      { EX: 7776000 }
    );
    expect(redis.del).toHaveBeenCalledWith(
      'release-note:6529seize-backend:pr-1749:processing'
    );
  });

  it('publishes retained services when old run metadata has expired', async () => {
    const redis = buildRedis();
    const generateAndPost = jest.fn().mockResolvedValue(undefined);
    await processRequest(request, { redis: redis as any, generateAndPost });
    redis.deleteValue('release-note-group:6529seize-backend:pr-1749:run:api');

    await processRequest(
      {
        ...request,
        run_id: '456',
        run_number: '46',
        run_url: 'https://github.com/example/actions/runs/456',
        service: 'worker',
        release_group_services: ['worker'],
        publish_release_note: true
      },
      { redis: redis as any, generateAndPost }
    );

    expect(generateAndPost).toHaveBeenCalledWith(
      expect.objectContaining({
        release_group_services: ['api', 'worker'],
        release_group_runs: [
          {
            service: 'worker',
            run_id: '456',
            run_number: '46',
            run_url: 'https://github.com/example/actions/runs/456'
          }
        ]
      }),
      {}
    );
    expect(generateAndPost).toHaveBeenCalledTimes(1);
  });

  it('does not record deduplication when no release baseline exists', async () => {
    const redis = buildRedis();

    await processRequest(
      { ...request, publish_release_note: true },
      {
        redis: redis as any,
        generateAndPost: jest.fn().mockResolvedValue('no-baseline')
      }
    );

    expect(redis.set).not.toHaveBeenCalledWith(
      'release-note:6529seize-backend:pr-1749',
      '1',
      { EX: 7776000 }
    );
    expect(redis.del).toHaveBeenCalledWith(
      'release-note:6529seize-backend:pr-1749:processing'
    );
  });

  it('keeps the latest successful run for a service before publication', async () => {
    const runKey = 'release-note-group:6529seize-backend:pr-1749:run:api';
    const originalRun = JSON.stringify({
      service: 'api',
      run_id: 'original-run',
      run_number: '44',
      run_url: 'https://github.com/example/actions/runs/original-run'
    });
    const redis = buildRedis({ [runKey]: originalRun });

    await processRequest(request, {
      redis: redis as any,
      generateAndPost: jest.fn()
    });

    expect(redis.set).toHaveBeenCalledWith(runKey, expect.any(String), {
      EX: 7776000
    });
    await expect(redis.get(runKey)).resolves.toContain('"run_id":"123"');
  });
});
