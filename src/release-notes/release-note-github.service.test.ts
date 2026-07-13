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

  it('does not use a frontend non-production run as the release baseline', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: jest.fn().mockReturnValue(null) },
      json: jest.fn().mockResolvedValue({
        workflow_runs: [
          {
            id: 122,
            name: 'Deploy Staging',
            display_title: 'Deploy Staging',
            head_sha: 'previous-sha',
            run_number: 44
          }
        ]
      })
    });

    const context = await new ReleaseNoteGitHubService().getReleaseContext({
      ...request,
      workflow: 'Deploy Staging',
      run_number: '45'
    });

    expect(context).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
