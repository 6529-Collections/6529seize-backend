const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({ get: mockRouterGet, post: mockRouterPost })
}));

jest.mock('@/api/deploy/deploy.github.service', () => ({
  gitHubDeployService: {
    assertRepositoryWriteAccess: jest.fn(),
    dispatchDeploy: jest.fn()
  }
}));

import type { Request, Response } from 'express';
import { gitHubDeployService } from '@/api/deploy/deploy.github.service';
import './deploy.routes';

type DispatchHandler = (
  request: Request,
  response: Response
) => Promise<unknown>;
const dispatchHandler = mockRouterPost.mock.calls.find(
  ([route]) => route === '/ui/dispatch'
)?.[1] as DispatchHandler;

const stagingRequest = {
  target: 'backend',
  ref: '1a-staging',
  environment: 'staging',
  services: ['api']
};

function makeRequest(body: unknown, authorization = 'Bearer token'): Request {
  return {
    body,
    get: jest.fn((name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined
    )
  } as unknown as Request;
}

function makeResponse() {
  return {
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn()
  };
}

describe('deploy UI dispatch route', () => {
  const github = jest.mocked(gitHubDeployService);

  beforeEach(() => {
    jest.clearAllMocks();
    github.assertRepositoryWriteAccess.mockResolvedValue(undefined);
    github.dispatchDeploy.mockResolvedValue(undefined);
  });

  it('authorizes repository access then dispatches one staging service', async () => {
    const response = makeResponse();

    await dispatchHandler(
      makeRequest(stagingRequest),
      response as unknown as Response
    );

    expect(github.assertRepositoryWriteAccess).toHaveBeenCalledWith(
      'token',
      'backend'
    );
    expect(github.dispatchDeploy).toHaveBeenCalledTimes(1);
    expect(github.dispatchDeploy).toHaveBeenCalledWith({
      token: 'token',
      target: 'backend',
      ref: '1a-staging',
      service: 'api',
      environment: 'staging',
      releasePullRequest: null,
      releaseGroupServices: '',
      releaseNoteOptOut: false
    });
    expect(
      github.assertRepositoryWriteAccess.mock.invocationCallOrder[0]
    ).toBeLessThan(github.dispatchDeploy.mock.invocationCallOrder[0]);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'backend',
        ref: '1a-staging',
        summary: { requested: 1, succeeded: 1, failed: 0 }
      })
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-cache, no-store, must-revalidate'
    );
  });

  it('requires a GitHub token before making any dispatch', async () => {
    await expect(
      dispatchHandler(
        makeRequest(stagingRequest, ''),
        makeResponse() as unknown as Response
      )
    ).rejects.toThrow('GitHub token is required');

    expect(github.assertRepositoryWriteAccess).not.toHaveBeenCalled();
    expect(github.dispatchDeploy).not.toHaveBeenCalled();
  });

  it('rejects a GitHub user without repository write access', async () => {
    github.assertRepositoryWriteAccess.mockRejectedValue(
      new Error('Write access required')
    );

    await expect(
      dispatchHandler(
        makeRequest(stagingRequest),
        makeResponse() as unknown as Response
      )
    ).rejects.toThrow('Write access required');

    expect(github.dispatchDeploy).not.toHaveBeenCalled();
  });

  it('rejects concurrent service batches before dispatching any service', async () => {
    await expect(
      dispatchHandler(
        makeRequest({
          ...stagingRequest,
          services: ['dbMigrationsLoop', 'api']
        }),
        makeResponse() as unknown as Response
      )
    ).rejects.toThrow();

    expect(github.dispatchDeploy).not.toHaveBeenCalled();
  });

  it('rejects a production-only service on staging', async () => {
    await expect(
      dispatchHandler(
        makeRequest({ ...stagingRequest, services: ['mediaResizerLoop'] }),
        makeResponse() as unknown as Response
      )
    ).rejects.toThrow('mediaResizerLoop cannot be deployed to staging');

    expect(github.dispatchDeploy).not.toHaveBeenCalled();
  });

  it('forwards the backend production PR and release-note group', async () => {
    await dispatchHandler(
      makeRequest({
        ...stagingRequest,
        ref: 'main',
        environment: 'prod',
        release_pull_request: 1801,
        release_group_services: 'dbMigrationsLoop,api'
      }),
      makeResponse() as unknown as Response
    );

    expect(github.dispatchDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'backend',
        ref: 'main',
        environment: 'prod',
        releasePullRequest: 1801,
        releaseGroupServices: 'dbMigrationsLoop,api',
        releaseNoteOptOut: false
      })
    );
  });

  it('dispatches frontend internal production with the explicit opt-out', async () => {
    await dispatchHandler(
      makeRequest({
        target: 'frontend',
        ref: 'main',
        environment: 'prod',
        release_note_opt_out: true
      }),
      makeResponse() as unknown as Response
    );

    expect(github.assertRepositoryWriteAccess).toHaveBeenCalledWith(
      'token',
      'frontend'
    );
    expect(github.dispatchDeploy).toHaveBeenCalledTimes(1);
    expect(github.dispatchDeploy).toHaveBeenCalledWith({
      token: 'token',
      target: 'frontend',
      ref: 'main',
      environment: 'prod',
      releasePullRequest: null,
      releaseGroupServices: '',
      releaseNoteOptOut: true
    });
  });

  it('reports an unsuccessful dispatch without hiding the GitHub error', async () => {
    const response = makeResponse();
    github.dispatchDeploy.mockRejectedValue(new Error('Workflow unavailable'));

    await dispatchHandler(
      makeRequest(stagingRequest),
      response as unknown as Response
    );

    expect(github.dispatchDeploy).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [
          { service: 'api', ok: false, message: 'Workflow unavailable' }
        ],
        summary: { requested: 1, succeeded: 0, failed: 1 }
      })
    );
  });
});
