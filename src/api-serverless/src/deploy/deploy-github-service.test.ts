import fetch from 'node-fetch';
import { GitHubDeployService } from '@/api/deploy/deploy.github.service';

jest.mock('node-fetch', () => jest.fn());

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get: jest.Mock<string | null, [string]>;
  };
  json: jest.Mock<Promise<unknown>, []>;
};

function createResponse(jsonPayload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: jest.fn().mockReturnValue(null)
    },
    json: jest.fn().mockResolvedValue(jsonPayload)
  };
}

describe('GitHubDeployService.listRefs', () => {
  const fetchMock = jest.mocked(fetch);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('uses matching refs lookup for typed queries', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createResponse([{ ref: 'refs/heads/main' }]) as never
      )
      .mockResolvedValueOnce(createResponse([]) as never);

    const service = new GitHubDeployService();
    const refs = await service.listRefs('token', 'backend', 'main', 20);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/repos/6529-Collections/6529seize-backend/git/matching-refs/heads/main'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      '/repos/6529-Collections/6529seize-backend/git/matching-refs/tags/main'
    );
    expect(refs).toEqual([{ name: 'main', type: 'branch' }]);
  });

  it('falls back to branch and tag listing when query is empty', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse([{ name: 'main' }]) as never)
      .mockResolvedValueOnce(createResponse([{ name: 'v1.0.0' }]) as never);

    const service = new GitHubDeployService();
    const refs = await service.listRefs('token', 'backend', '', 20);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/branches?per_page=100');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/tags?per_page=100');
    expect(refs).toEqual([
      { name: 'main', type: 'branch' },
      { name: 'v1.0.0', type: 'tag' }
    ]);
  });
});

describe('GitHubDeployService.dispatchDeploy', () => {
  const fetchMock = jest.mocked(fetch);

  beforeEach(() => {
    jest.resetAllMocks();
    fetchMock.mockResolvedValue(createResponse({}) as never);
  });

  function expectDispatch(repository: string, workflow: string, body: unknown) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/6529-Collections/${repository}/actions/workflows/${workflow}/dispatches`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' })
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      body
    );
  }

  it('dispatches backend staging with ordinary workflow inputs', async () => {
    await new GitHubDeployService().dispatchDeploy({
      token: 'token',
      target: 'backend',
      ref: '1a-staging',
      environment: 'staging',
      service: 'api'
    });

    expectDispatch('6529seize-backend', 'deploy.yml', {
      ref: '1a-staging',
      inputs: {
        environment: 'staging',
        service: 'api',
        release_note_opt_out: 'false'
      }
    });
  });

  it('dispatches backend production with release-note group metadata', async () => {
    await new GitHubDeployService().dispatchDeploy({
      token: 'token',
      ref: 'main',
      environment: 'prod',
      service: 'api',
      releasePullRequest: 1801,
      releaseGroupServices: 'dbMigrationsLoop,api'
    });

    expectDispatch('6529seize-backend', 'deploy.yml', {
      ref: 'main',
      inputs: {
        environment: 'prod',
        service: 'api',
        release_note_opt_out: 'false',
        release_pull_request: '1801',
        release_group_services: 'dbMigrationsLoop,api',
        release_note_publish: 'true'
      }
    });
  });

  it('defaults a production service group to the selected service', async () => {
    await new GitHubDeployService().dispatchDeploy({
      token: 'token',
      ref: 'main',
      environment: 'prod',
      service: 'api',
      releasePullRequest: 1801
    });

    expectDispatch('6529seize-backend', 'deploy.yml', {
      ref: 'main',
      inputs: {
        environment: 'prod',
        service: 'api',
        release_note_opt_out: 'false',
        release_pull_request: '1801',
        release_group_services: 'api',
        release_note_publish: 'true'
      }
    });
  });

  it('dispatches internal production with explicit release-note opt-out', async () => {
    await new GitHubDeployService().dispatchDeploy({
      token: 'token',
      ref: 'main',
      environment: 'prod',
      service: 'api',
      releaseNoteOptOut: true
    });

    expectDispatch('6529seize-backend', 'deploy.yml', {
      ref: 'main',
      inputs: {
        environment: 'prod',
        service: 'api',
        release_note_opt_out: 'true'
      }
    });
  });

  it.each([false, true])(
    'dispatches frontend production with release-note opt-out %s',
    async (releaseNoteOptOut) => {
      await new GitHubDeployService().dispatchDeploy({
        token: 'token',
        target: 'frontend',
        ref: 'main',
        environment: 'prod',
        releaseNoteOptOut
      });

      expectDispatch('6529seize-frontend', 'build-upload-deploy-prod.yml', {
        ref: 'main',
        inputs: { release_note_opt_out: String(releaseNoteOptOut) }
      });
    }
  );

  it('surfaces GitHub permission failures without retrying dispatch', async () => {
    const response = createResponse({ message: 'Resource not accessible' });
    response.ok = false;
    response.status = 403;
    fetchMock.mockResolvedValue(response as never);

    await expect(
      new GitHubDeployService().dispatchDeploy({
        token: 'token',
        ref: '1a-staging',
        environment: 'staging',
        service: 'api'
      })
    ).rejects.toThrow(
      'GitHub token cannot dispatch workflows: Resource not accessible'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
