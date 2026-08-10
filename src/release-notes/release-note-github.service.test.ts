jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn()
}));

import fetch from 'node-fetch';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import {
  AlreadyDeployedReleaseShaError,
  NonForwardReleaseRangeError,
  ReleaseNoteGitHubService
} from './release-note-github.service';

const request: ReleaseNoteGenerationRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  run_id: '123',
  run_url: 'https://github.com/example/actions/runs/123',
  sha: 'abc123',
  environment: 'prod',
  service: 'web',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'frontend-release',
  release_group_services: ['web'],
  deployed_at: '2026-07-13T11:38:00.000Z'
};

const response = (payload: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: jest.fn().mockReturnValue(null) },
  json: jest.fn().mockResolvedValue(payload)
});

const currentRun = {
  id: 123,
  name: 'Web Deploy - PROD',
  display_title: 'Web Deploy - PROD',
  head_sha: 'abc123',
  run_number: 45,
  workflow_id: 7,
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-07-13T11:38:00Z',
  path: '.github/workflows/build-upload-deploy-prod.yml@refs/heads/main'
};

describe('ReleaseNoteGitHubService', () => {
  const originalToken = process.env.RELEASE_NOTES_GITHUB_TOKEN;

  beforeEach(() => {
    process.env.RELEASE_NOTES_GITHUB_TOKEN = 'github-token';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalToken === undefined) {
      delete process.env.RELEASE_NOTES_GITHUB_TOKEN;
    } else {
      process.env.RELEASE_NOTES_GITHUB_TOKEN = originalToken;
    }
  });

  it('loads the allowlisted prompt from the exact deployed SHA', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: jest.fn().mockReturnValue(null) },
      json: jest.fn().mockResolvedValue({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('Reviewed repository prompt.').toString('base64')
      })
    });

    const prompt = await new ReleaseNoteGitHubService().getReleasePrompt(
      request
    );

    expect(prompt).toBe('Reviewed repository prompt.');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/6529-Collections/6529seize-frontend/contents/ops/release-notes/release-notes.prompt.md?ref=abc123',
      expect.objectContaining({
        redirect: 'error',
        size: 5 * 1024 * 1024,
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('rejects an unreviewed prompt path before calling GitHub', async () => {
    await expect(
      new ReleaseNoteGitHubService().getReleasePrompt({
        ...request,
        prompt_path: 'unreviewed.prompt.md'
      })
    ).rejects.toThrow('Unsupported release notes prompt');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds a backend release context from exactly the declared PR', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(
        response({
          ...currentRun,
          name: 'Deploy api to prod',
          display_title: 'Deploy api to prod',
          head_sha: 'current-sha'
        })
      )
      .mockResolvedValueOnce(
        response({
          number: 1749,
          html_url:
            'https://github.com/6529-Collections/6529seize-backend/pull/1749',
          title: 'Link Main Stage winners to Meme cards',
          body: 'Adds the production mapping.',
          merged_at: '2026-07-14T12:00:00Z',
          merge_commit_sha: 'merge-sha',
          user: { login: 'Alice', type: 'User' },
          base: { ref: 'main' }
        })
      )
      .mockResolvedValueOnce(response({ status: 'ahead' }))
      .mockResolvedValueOnce(
        response([
          {
            filename: 'src/api-serverless/src/drops/api-drop.mapper.ts',
            additions: 10,
            deletions: 2,
            changes: 12
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            sha: 'first',
            author: { login: 'bob', type: 'User' },
            committer: { login: 'CAROL', type: 'User' }
          },
          {
            sha: 'branch-sync',
            author: { login: 'Dave', type: 'User' },
            committer: { login: 'web-flow', type: 'User' }
          },
          {
            sha: 'bot-change',
            author: { login: 'dependabot[bot]', type: 'Bot' },
            committer: { login: 'release-app[bot]', type: 'Bot' }
          },
          {
            sha: 'non-user-change',
            author: {
              login: 'release-organization',
              type: 'Organization'
            },
            committer: { login: 'release-app', type: 'App' }
          }
        ])
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      repo: '6529seize-backend',
      workflow: 'Deploy a service',
      run_number: '45',
      sha: 'current-sha',
      branch: 'main',
      service: 'api',
      release_group_id: 'pr-1749',
      release_group_services: ['dbMigrationsLoop', 'claimsBuilder', 'api'],
      contributor_github_logins: [
        'ReleaseTrainUser',
        'BOB',
        'release-app[bot]',
        'alice'
      ],
      pull_request_number: 1749
    });

    expect(context).toEqual({
      previous_sha: 'merge-sha',
      current_sha: 'current-sha',
      pull_requests: [
        {
          number: 1749,
          url: 'https://github.com/6529-Collections/6529seize-backend/pull/1749',
          title: 'Link Main Stage winners to Meme cards',
          body: 'Adds the production mapping.',
          contributors: ['Alice', 'bob', 'CAROL', 'Dave'],
          commit_messages: ['Link Main Stage winners to Meme cards'],
          changed_files: [
            {
              filename: 'src/api-serverless/src/drops/api-drop.mapper.ts',
              additions: 10,
              deletions: 2,
              changes: 12
            }
          ],
          candidate_services: ['api', 'claimsBuilder', 'dbMigrationsLoop']
        }
      ]
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/6529-Collections/6529seize-backend/pulls/1749',
      expect.any(Object)
    );
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      'https://api.github.com/repos/6529-Collections/6529seize-backend/pulls/1749/commits?per_page=100&page=1',
      expect.any(Object)
    );
  });

  it('rejects a frontend non-production workflow', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce(response(currentRun));

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext({
        ...request,
        workflow: 'Deploy Staging',
        run_number: '45'
      })
    ).rejects.toThrow('not an approved frontend production workflow run');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects inherited object properties as frontend workflow names', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce(
      response({
        ...currentRun,
        name: 'constructor',
        path: '.github/workflows/constructor@refs/heads/main'
      })
    );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext({
        ...request,
        workflow: 'constructor'
      })
    ).rejects.toThrow('not an approved frontend production workflow run');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['queued', null, { status: 'queued' }],
    ['completed with failure', 'failure', { status: 'completed' }],
    ['completed with cancellation', 'cancelled', { status: 'completed' }],
    [
      'wrong workflow path',
      'success',
      { path: '.github/workflows/other-production.yml@refs/heads/main' }
    ],
    ['missing workflow path', 'success', { path: undefined }],
    ['wrong branch', 'success', { head_branch: 'release' }],
    ['missing branch', 'success', { head_branch: undefined }]
  ])(
    'rejects frontend current-run evidence in the %s state',
    async (_label, conclusion, overrides) => {
      (fetch as unknown as jest.Mock).mockResolvedValueOnce(
        response({
          ...currentRun,
          conclusion,
          ...overrides
        })
      );

      await expect(
        new ReleaseNoteGitHubService().getReleaseContext(request)
      ).rejects.toThrow('not an approved frontend production workflow run');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['wrong run ID', { id: 124 }],
    ['wrong deployed SHA', { head_sha: 'different-sha' }]
  ])(
    'rejects frontend current-run evidence with a %s',
    async (_label, overrides) => {
      (fetch as unknown as jest.Mock).mockResolvedValueOnce(
        response({
          ...currentRun,
          ...overrides
        })
      );

      await expect(
        new ReleaseNoteGitHubService().getReleaseContext(request)
      ).rejects.toThrow('does not match the queued release metadata');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a completed successful frontend run for replay compatibility', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...currentRun,
              id: 122,
              head_sha: 'previous-sha',
              run_number: 44,
              created_at: '2026-07-12T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context).toEqual({
      previous_sha: 'previous-sha',
      current_sha: 'abc123',
      pull_requests: []
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/6529-Collections/6529seize-frontend/actions/workflows/build-upload-deploy-prod.yml/runs?status=success&branch=main&per_page=100&page=1',
      expect.any(Object)
    );
  });

  it('accepts custom run names while binding manual production to its approved workflow file', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(
        response({
          ...currentRun,
          name: 'Production deploy abc123 [frontend-prod-123]',
          display_title: 'Production deploy abc123 [frontend-prod-123]'
        })
      )
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...currentRun,
              id: 122,
              name: 'Production deploy previous-sha [frontend-prod-122]',
              display_title:
                'Production deploy previous-sha [frontend-prod-122]',
              head_sha: 'previous-sha',
              run_number: 44,
              created_at: '2026-07-12T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext(request)
    ).resolves.toEqual({
      previous_sha: 'previous-sha',
      current_sha: 'abc123',
      pull_requests: []
    });
  });

  it.each([
    [
      'another workflow path',
      { path: '.github/workflows/deploy-staging.yml@refs/heads/main' }
    ],
    ['a missing workflow path', { path: undefined }],
    ['another branch', { head_branch: '1a-staging' }]
  ])(
    'does not use a manual production baseline from %s',
    async (_label, overrides) => {
      (fetch as unknown as jest.Mock)
        .mockResolvedValueOnce(response(currentRun))
        .mockResolvedValueOnce(
          response({
            workflow_runs: [
              {
                ...currentRun,
                id: 122,
                head_sha: 'previous-sha',
                run_number: 44,
                created_at: '2026-07-12T11:38:00Z',
                ...overrides
              }
            ]
          })
        )
        .mockResolvedValueOnce(response({ workflow_runs: [] }));

      await expect(
        new ReleaseNoteGitHubService().getReleaseContext(request)
      ).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  );

  it('accepts a live manual frontend production notification run', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(
        response({
          ...currentRun,
          status: 'in_progress',
          conclusion: null
        })
      )
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...currentRun,
              id: 122,
              head_sha: 'previous-sha',
              run_number: 44,
              created_at: '2026-07-12T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext(request)
    ).resolves.toEqual({
      previous_sha: 'previous-sha',
      current_sha: 'abc123',
      pull_requests: []
    });
  });

  it('builds the run #15 Release Bus context from the preceding Release Bus production run', async () => {
    const deployedSha = '9d85844ca9c63274083612f211463d31588ae954';
    const releaseBusRequest: ReleaseNoteGenerationRequest = {
      ...request,
      workflow: 'Release Bus - Deploy Frontend Production',
      run_id: '30379747148',
      run_number: '15',
      run_url:
        'https://github.com/6529-Collections/6529seize-frontend/actions/runs/30379747148',
      sha: deployedSha,
      branch: 'main'
    };
    const releaseBusRun = {
      id: 30379747148,
      name: 'Release Bus - Deploy Frontend Production',
      display_title: 'Deploy frontend production train',
      head_sha: deployedSha,
      head_branch: 'main',
      run_number: 15,
      workflow_id: 99,
      status: 'in_progress',
      conclusion: null,
      created_at: '2026-07-23T11:38:00Z',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(releaseBusRun))
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...releaseBusRun,
              id: 30370000000,
              head_sha: '8'.repeat(40),
              run_number: 14,
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-07-22T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        response({
          commits: [
            {
              sha: deployedSha,
              author: { login: 'prxt6529', type: 'User' },
              committer: { login: 'web-flow', type: 'User' },
              commit: { message: 'Restore Release Bus frontend release notes' }
            }
          ],
          total_commits: 1,
          status: 'ahead'
        })
      )
      .mockResolvedValueOnce(
        response([
          {
            number: 3498,
            html_url:
              'https://github.com/6529-Collections/6529seize-frontend/pull/3498',
            title: 'Restore Release Bus frontend production release notes',
            body: 'Restore the reviewed prompt path.',
            merged_at: '2026-07-23T10:00:00Z',
            user: { login: 'prxt6529', type: 'User' },
            base: { ref: 'main' }
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            filename: '.github/workflows/release-bus-deploy-production.yml',
            additions: 1,
            deletions: 0,
            changes: 1
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            sha: deployedSha,
            author: { login: 'prxt6529', type: 'User' },
            committer: { login: 'web-flow', type: 'User' }
          }
        ])
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      releaseBusRequest
    );

    expect(context).toEqual({
      previous_sha: '8'.repeat(40),
      current_sha: deployedSha,
      pull_requests: [
        expect.objectContaining({
          number: 3498,
          contributors: ['prxt6529']
        })
      ]
    });
  });

  it('stops production-history pagination after finding a valid baseline', async () => {
    const releaseBusRun = {
      ...currentRun,
      name: 'Release Bus - Deploy Frontend Production',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    const previousRun = {
      ...releaseBusRun,
      id: 122,
      head_sha: 'previous-sha',
      run_number: 44,
      created_at: '2026-07-12T11:38:00Z'
    };
    const excludedSameShaRuns = Array.from({ length: 99 }, (_, index) => ({
      ...releaseBusRun,
      id: 1000 + index,
      created_at: `2026-07-12T10:${String(index % 60).padStart(2, '0')}:00Z`
    }));
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(releaseBusRun))
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [previousRun, ...excludedSameShaRuns]
        })
      )
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      workflow: releaseBusRun.name
    });

    expect(context?.previous_sha).toBe('previous-sha');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      (fetch as unknown as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes('page=2')
      )
    ).toBe(false);
  });

  it('bridges the first Release Bus production run to the latest approved manual production run', async () => {
    const releaseBusRun = {
      ...currentRun,
      name: 'Release Bus - Deploy Frontend Production',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(releaseBusRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...currentRun,
              id: 122,
              head_sha: 'manual-production-sha',
              created_at: '2026-07-12T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      workflow: releaseBusRun.name
    });

    expect(context?.previous_sha).toBe('manual-production-sha');
  });

  it('uses a newer manual production run before a later Release Bus run', async () => {
    const releaseBusRun = {
      ...currentRun,
      name: 'Release Bus - Deploy Frontend Production',
      created_at: '2026-07-13T12:00:00Z',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    const priorReleaseBus = {
      ...releaseBusRun,
      id: 121,
      head_sha: 'older-release-bus-sha',
      created_at: '2026-07-10T12:00:00Z'
    };
    const priorManual = {
      ...currentRun,
      id: 122,
      head_sha: 'newer-manual-production-sha',
      created_at: '2026-07-12T12:00:00Z'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(releaseBusRun))
      .mockResolvedValueOnce(response({ workflow_runs: [priorManual] }))
      .mockResolvedValueOnce(response({ workflow_runs: [priorReleaseBus] }))
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      workflow: releaseBusRun.name
    });

    expect(context?.previous_sha).toBe('newer-manual-production-sha');
  });

  it('allows an approved manual production run to follow Release Bus production', async () => {
    const priorReleaseBus = {
      ...currentRun,
      id: 122,
      name: 'Release Bus - Deploy Frontend Production',
      head_sha: 'release-bus-production-sha',
      created_at: '2026-07-12T12:00:00Z',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(response({ workflow_runs: [priorReleaseBus] }))
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context?.previous_sha).toBe('release-bus-production-sha');
  });

  it('returns no baseline when approved production history is absent', async () => {
    const releaseBusRun = {
      ...currentRun,
      name: 'Release Bus - Deploy Frontend Production',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(releaseBusRun))
      .mockResolvedValueOnce(response({ workflow_runs: [] }))
      .mockResolvedValueOnce(response({ workflow_runs: [] }));

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext({
        ...request,
        workflow: releaseBusRun.name
      })
    ).resolves.toBeNull();
  });

  it('stops a same-SHA redeployment before falling through to an older baseline', async () => {
    const releaseBusRun = {
      ...currentRun,
      name: 'Release Bus - Deploy Frontend Production',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(releaseBusRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...currentRun,
              id: 121,
              head_sha: 'older-different-sha',
              created_at: '2026-07-11T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              ...releaseBusRun,
              id: 122,
              created_at: '2026-07-12T11:38:00Z'
            }
          ]
        })
      );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext({
        ...request,
        workflow: releaseBusRun.name
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<AlreadyDeployedReleaseShaError>>({
        name: 'AlreadyDeployedReleaseShaError',
        sha: request.sha,
        previousRunId: 122
      })
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['behind', 'diverged', 'identical', undefined])(
    'omits release notes when the production comparison status is %s',
    async (status) => {
      (fetch as unknown as jest.Mock)
        .mockResolvedValueOnce(response(currentRun))
        .mockResolvedValueOnce(
          response({
            workflow_runs: [
              {
                ...currentRun,
                id: 122,
                head_sha: 'previous-sha',
                run_number: 44,
                created_at: '2026-07-12T11:38:00Z'
              }
            ]
          })
        )
        .mockResolvedValueOnce(response({ workflow_runs: [] }))
        .mockResolvedValueOnce(
          response({
            commits: [{ sha: 'unsafe-commit' }],
            total_commits: 1,
            status
          })
        );

      await expect(
        new ReleaseNoteGitHubService().getReleaseContext(request)
      ).rejects.toEqual(
        expect.objectContaining<Partial<NonForwardReleaseRangeError>>({
          name: 'NonForwardReleaseRangeError',
          previousSha: 'previous-sha',
          currentSha: 'abc123',
          comparisonStatus: status
        })
      );
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  );

  it('uses service-specific backend run names from the deploy workflow', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(
        response({
          id: 123,
          name: 'Deploy claimsBuilder to prod',
          display_title: 'Deploy claimsBuilder to prod',
          head_sha: 'current-sha',
          run_number: 45,
          workflow_id: 82013288
        })
      )
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Deploy api to prod',
              display_title: 'Deploy api to prod',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 82013288
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        response({
          commits: [
            {
              sha: 'api-commit',
              author: { login: 'simo6529', type: 'User' },
              commit: { message: 'Improve API validation' }
            },
            {
              sha: 'claims-commit',
              author: { login: 'ragnep', type: 'User' },
              commit: { message: 'Update claims builder' }
            }
          ],
          total_commits: 2,
          status: 'ahead'
        })
      )
      .mockResolvedValueOnce(
        response([
          {
            number: 101,
            html_url: 'https://github.com/example/pull/101',
            title: 'Improve API validation',
            body: null,
            merged_at: '2026-07-13T10:00:00Z',
            user: { login: 'simo6529', type: 'User' },
            base: { ref: 'main' }
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            number: 102,
            html_url: 'https://github.com/example/pull/102',
            title: 'Update claims builder',
            body: null,
            merged_at: '2026-07-13T10:05:00Z',
            user: { login: 'ragnep', type: 'User' },
            base: { ref: 'main' }
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            filename: 'src/api-serverless/src/profiles/routes.ts',
            additions: 4,
            deletions: 1,
            changes: 5,
            patch: 'x'.repeat(300000),
            blob_url: 'https://github.com/example/blob/api-commit/routes.ts'
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            sha: 'api-pr-commit',
            author: { login: 'api-coauthor', type: 'User' },
            committer: { login: 'simo6529', type: 'User' }
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            filename: 'src/claimsBuilder/index.ts',
            additions: 6,
            deletions: 2,
            changes: 8
          }
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            sha: 'claims-pr-commit',
            author: { login: 'claims-coauthor', type: 'User' },
            committer: { login: 'automation[bot]', type: 'Bot' }
          }
        ])
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      repo: '6529seize-backend',
      workflow: 'Deploy a service',
      run_number: '45',
      sha: 'current-sha',
      branch: 'main',
      release_group_id: 'backend-release',
      release_group_services: ['api', 'claimsBuilder']
    });

    expect(context?.pull_requests).toEqual([
      expect.objectContaining({
        number: 101,
        contributors: ['simo6529', 'api-coauthor'],
        candidate_services: ['api'],
        changed_files: [
          {
            filename: 'src/api-serverless/src/profiles/routes.ts',
            additions: 4,
            deletions: 1,
            changes: 5
          }
        ]
      }),
      expect.objectContaining({
        number: 102,
        contributors: ['ragnep', 'claims-coauthor'],
        candidate_services: ['claimsBuilder']
      })
    ]);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/6529-Collections/6529seize-backend/actions/workflows/82013288/runs?status=success&branch=main&per_page=100&page=1',
      expect.any(Object)
    );
  });

  it('does not add train-wide contributors to commit-range PR contexts', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(
        response({
          id: 123,
          name: 'Deploy api to prod',
          display_title: 'Deploy api to prod',
          head_sha: 'current-sha',
          run_number: 45,
          workflow_id: 82013288
        })
      )
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Deploy api to prod',
              display_title: 'Deploy api to prod',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 82013288
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        response({
          commits: [
            {
              sha: 'api-commit',
              commit: { message: 'Improve API validation' }
            }
          ],
          total_commits: 1,
          status: 'ahead'
        })
      )
      .mockResolvedValueOnce(
        response([
          {
            number: 101,
            html_url: 'https://github.com/example/pull/101',
            title: 'Improve API validation',
            body: null,
            merged_at: '2026-07-13T10:00:00Z',
            user: { login: 'pr-author', type: 'User' },
            base: { ref: 'main' }
          }
        ])
      )
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      repo: '6529seize-backend',
      workflow: 'Deploy a service',
      run_number: '45',
      sha: 'current-sha',
      branch: 'main',
      release_group_id: 'backend-release',
      release_group_services: ['api'],
      contributor_github_logins: ['release-train-contributor']
    });

    expect(context?.pull_requests).toEqual([
      expect.objectContaining({
        number: 101,
        contributors: ['pr-author']
      })
    ]);
  });

  it('keeps every PR when one changed-file list exceeds the enrichment cap', async () => {
    (fetch as unknown as jest.Mock).mockImplementation((url: string) => {
      if (url.endsWith('/actions/runs/123')) {
        return Promise.resolve(response(currentRun));
      }
      if (
        url.includes('/actions/workflows/build-upload-deploy-prod.yml/runs?')
      ) {
        return Promise.resolve(
          response({
            workflow_runs: [
              {
                ...currentRun,
                id: 122,
                head_sha: 'previous-sha',
                run_number: 44,
                created_at: '2026-07-12T11:38:00Z'
              }
            ]
          })
        );
      }
      if (
        url.includes(
          '/actions/workflows/release-bus-deploy-production.yml/runs?'
        )
      ) {
        return Promise.resolve(response({ workflow_runs: [] }));
      }
      if (url.includes('/compare/previous-sha...abc123')) {
        return Promise.resolve(
          response({
            commits: [
              {
                sha: 'large-merge',
                commit: { message: 'Add exact Stream public review snapshot' }
              },
              {
                sha: 'normal-merge',
                commit: { message: 'Improve navigation' }
              }
            ],
            total_commits: 2,
            status: 'ahead'
          })
        );
      }
      if (url.includes('/commits/large-merge/pulls')) {
        return Promise.resolve(
          response([
            {
              number: 3472,
              html_url: 'https://github.com/example/pull/3472',
              title: 'Add exact Stream public review snapshot',
              body: 'Adds the public review snapshot.',
              merged_at: '2026-07-26T20:40:13Z',
              changed_files: 628,
              user: { login: 'snapshot-author', type: 'User' },
              base: { ref: 'main' }
            }
          ])
        );
      }
      if (url.includes('/commits/normal-merge/pulls')) {
        return Promise.resolve(
          response([
            {
              number: 3473,
              html_url: 'https://github.com/example/pull/3473',
              title: 'Improve navigation',
              body: 'Keeps navigation usable.',
              merged_at: '2026-07-26T20:45:13Z',
              user: { login: 'navigation-author', type: 'User' },
              base: { ref: 'main' }
            }
          ])
        );
      }
      if (url.includes('/pulls/3472/files?')) {
        const page = Number(new URL(url).searchParams.get('page'));
        return Promise.resolve(
          response(
            Array.from({ length: 100 }, (_, index) => ({
              filename: `snapshot/page-${page}/file-${index}.json`,
              additions: 1,
              deletions: 0,
              changes: 1
            }))
          )
        );
      }
      if (url.includes('/pulls/3473/files?')) {
        return Promise.resolve(
          response([
            {
              filename: 'components/navigation.tsx',
              additions: 2,
              deletions: 1,
              changes: 3
            }
          ])
        );
      }
      if (url.includes('/pulls/3472/commits?')) {
        return Promise.resolve(
          response([
            {
              sha: 'large-pr-commit',
              author: { login: 'snapshot-author', type: 'User' }
            }
          ])
        );
      }
      if (url.includes('/pulls/3473/commits?')) {
        return Promise.resolve(
          response([
            {
              sha: 'normal-pr-commit',
              author: { login: 'navigation-author', type: 'User' }
            }
          ])
        );
      }
      throw new Error(`Unexpected GitHub URL ${url}`);
    });

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context?.pull_requests).toHaveLength(2);
    expect(context?.pull_requests[0]).toEqual(
      expect.objectContaining({
        number: 3472,
        changed_files: expect.any(Array),
        changed_files_incomplete: true
      })
    );
    expect(context?.pull_requests[0].changed_files).toHaveLength(300);
    expect(context?.pull_requests[1]).toEqual(
      expect.objectContaining({
        number: 3473,
        changed_files: [
          {
            filename: 'components/navigation.tsx',
            additions: 2,
            deletions: 1,
            changes: 3
          }
        ]
      })
    );
    expect(context?.pull_requests[1].changed_files_incomplete).toBeUndefined();
    expect(
      (fetch as unknown as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes('/pulls/3472/files?per_page=100&page=4')
      )
    ).toBe(false);
  });

  it('uses minimal PR context when optional GitHub enrichment fails', async () => {
    (fetch as unknown as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/actions/runs/123')) {
        return Promise.resolve(
          response({
            ...currentRun,
            name: 'Deploy api to prod',
            display_title: 'Deploy api to prod',
            head_sha: 'merge-sha'
          })
        );
      }
      if (url.endsWith('/pulls/1749')) {
        return Promise.resolve(
          response({
            number: 1749,
            html_url: 'https://github.com/example/pull/1749',
            title: 'Keep release notes available',
            body: 'Adds graceful fallback behavior.',
            merged_at: '2026-07-27T12:00:00Z',
            merge_commit_sha: 'merge-sha',
            user: { login: 'pr-author', type: 'User' },
            base: { ref: 'main' }
          })
        );
      }
      if (
        url.includes('/pulls/1749/files?') ||
        url.includes('/pulls/1749/commits?')
      ) {
        return Promise.reject(new Error('GitHub enrichment unavailable'));
      }
      throw new Error(`Unexpected GitHub URL ${url}`);
    });

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      repo: '6529seize-backend',
      workflow: 'Deploy a service',
      sha: 'merge-sha',
      branch: 'main',
      service: 'api',
      release_group_id: 'pr-1749',
      release_group_services: ['api'],
      contributor_github_logins: ['release-train-contributor'],
      pull_request_number: 1749
    });

    expect(context?.pull_requests).toEqual([
      expect.objectContaining({
        number: 1749,
        title: 'Keep release notes available',
        contributors: ['pr-author'],
        changed_files: [],
        changed_files_incomplete: true,
        commit_contributors_incomplete: true,
        candidate_services: ['api']
      })
    ]);
  });

  it('paginates past successful runs from the current backend SHA', async () => {
    const sameShaRuns = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      name: `Deploy service${index} to prod`,
      display_title: `Deploy service${index} to prod`,
      head_sha: 'current-sha',
      run_number: 199 - index,
      workflow_id: 82013288
    }));
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(
        response({
          id: 123,
          name: 'Deploy s3Uploader to prod',
          display_title: 'Deploy s3Uploader to prod',
          head_sha: 'current-sha',
          run_number: 200,
          workflow_id: 82013288
        })
      )
      .mockResolvedValueOnce(response({ workflow_runs: sameShaRuns }))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Deploy api to prod',
              display_title: 'Deploy api to prod',
              head_sha: 'previous-sha',
              run_number: 99,
              workflow_id: 82013288
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        response({ commits: [], total_commits: 0, status: 'ahead' })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      repo: '6529seize-backend',
      workflow: 'Deploy a service',
      run_number: '200',
      sha: 'current-sha',
      branch: 'main',
      service: 's3Uploader',
      release_group_id: 'backend-release',
      release_group_services: ['s3Uploader']
    });

    expect(context?.previous_sha).toBe('previous-sha');
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/6529-Collections/6529seize-backend/actions/workflows/82013288/runs?status=success&branch=main&per_page=100&page=2',
      expect.any(Object)
    );
  });
});
