jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn()
}));

import fetch from 'node-fetch';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import { ReleaseNoteGitHubService } from './release-note-github.service';

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
  path: '.github/workflows/build-upload-deploy-prod.yml',
  head_branch: 'main',
  head_sha: 'abc123',
  run_number: 45,
  workflow_id: 7
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

  it('does not use a frontend non-production run as the release baseline', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Deploy Staging',
              display_title: 'Deploy Staging',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 7
            }
          ]
        })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      workflow: 'Deploy Staging',
      run_number: '45'
    });

    expect(context).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses a custom-named frontend production run as the release baseline', async () => {
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
              id: 122,
              name: 'Production deploy previous-sha [frontend-prod-122]',
              display_title:
                'Production deploy previous-sha [frontend-prod-122]',
              path: '.github/workflows/build-upload-deploy-prod.yml',
              head_branch: 'main',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 7
            }
          ]
        })
      )
      .mockResolvedValueOnce(response({ commits: [], total_commits: 0 }));

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context).toEqual({
      previous_sha: 'previous-sha',
      current_sha: 'abc123',
      pull_requests: []
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/6529-Collections/6529seize-frontend/actions/workflows/7/runs?status=success&branch=main&per_page=100&page=1',
      expect.any(Object)
    );
  });

  it('rejects a frontend release from another current workflow path', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce(
      response({
        ...currentRun,
        path: '.github/workflows/deploy-staging.yml'
      })
    );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext(request)
    ).rejects.toThrow(
      'GitHub release run 123 does not match the queued release metadata'
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a frontend release without a current workflow path', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce(
      response({ ...currentRun, path: undefined })
    );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext(request)
    ).rejects.toThrow(
      'GitHub release run 123 does not match the queued release metadata'
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a frontend release from another current branch', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce(
      response({
        ...currentRun,
        head_branch: '1a-staging'
      })
    );

    await expect(
      new ReleaseNoteGitHubService().getReleaseContext(request)
    ).rejects.toThrow(
      'GitHub release run 123 does not match the queued release metadata'
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not use a custom-named run from another workflow path', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Production deploy previous-sha [frontend-prod-122]',
              display_title:
                'Production deploy previous-sha [frontend-prod-122]',
              path: '.github/workflows/deploy-staging.yml',
              head_branch: 'main',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 7
            }
          ]
        })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not use a frontend production run without a workflow path', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Production deploy previous-sha [frontend-prod-122]',
              display_title:
                'Production deploy previous-sha [frontend-prod-122]',
              head_branch: 'main',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 7
            }
          ]
        })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not use a frontend production run from another branch', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Production deploy previous-sha [frontend-prod-122]',
              display_title:
                'Production deploy previous-sha [frontend-prod-122]',
              path: '.github/workflows/build-upload-deploy-prod.yml',
              head_branch: '1a-staging',
              head_sha: 'previous-sha',
              run_number: 44,
              workflow_id: 7
            }
          ]
        })
      );

    const context = await new ReleaseNoteGitHubService().getReleaseContext(
      request
    );

    expect(context).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

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
              author: { login: 'simo6529' },
              commit: { message: 'Improve API validation' }
            },
            {
              sha: 'claims-commit',
              author: { login: 'ragnep' },
              commit: { message: 'Update claims builder' }
            }
          ],
          total_commits: 2
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
            user: { login: 'simo6529' },
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
            user: { login: 'ragnep' },
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
          total_commits: 1
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
      if (url.includes('/actions/workflows/7/runs?')) {
        return Promise.resolve(
          response({
            workflow_runs: [
              {
                ...currentRun,
                id: 122,
                head_sha: 'previous-sha',
                run_number: 44
              }
            ]
          })
        );
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
            total_commits: 2
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
      .mockResolvedValueOnce(response({ commits: [], total_commits: 0 }));

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
