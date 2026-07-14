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
          user: { login: 'prxt0' },
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
          contributors: ['prxt0'],
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
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/6529-Collections/6529seize-backend/pulls/1749',
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

  it('finds a previous production run when run_number is missing', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(response(currentRun))
      .mockResolvedValueOnce(
        response({
          workflow_runs: [
            {
              id: 122,
              name: 'Web Deploy - PROD',
              display_title: 'Web Deploy - PROD',
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
            filename: 'src/claimsBuilder/index.ts',
            additions: 6,
            deletions: 2,
            changes: 8
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
        candidate_services: ['claimsBuilder']
      })
    ]);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/6529-Collections/6529seize-backend/actions/workflows/82013288/runs?status=success&branch=main&per_page=100&page=1',
      expect.any(Object)
    );
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
