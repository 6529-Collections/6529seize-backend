const mockFindOperation = jest.fn();
const mockGetLane = jest.fn();
const mockBindOperationAuthorization = jest.fn();
const mockAppendEvent = jest.fn();
const mockGetWorkflowRunIdentity = jest.fn();
const mockIsOrganizationOperator = jest.fn();
const mockPauseForBreakGlass = jest.fn();

jest.mock('@/releaseBus/release-bus.repository', () => ({
  releaseBusRepository: {
    findOperation: (...args: unknown[]) => mockFindOperation(...args),
    getLane: (...args: unknown[]) => mockGetLane(...args),
    bindOperationAuthorization: (...args: unknown[]) =>
      mockBindOperationAuthorization(...args),
    appendEvent: (...args: unknown[]) => mockAppendEvent(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    getWorkflowRunIdentity: (...args: unknown[]) =>
      mockGetWorkflowRunIdentity(...args),
    isOrganizationOperator: (...args: unknown[]) =>
      mockIsOrganizationOperator(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.service', () => ({
  releaseBusService: {
    pauseForBreakGlass: (...args: unknown[]) => mockPauseForBreakGlass(...args)
  }
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import deployRoutes from '@/api/deploy/deploy.routes';

const WORKFLOW_TOKEN = 'release-bus-workflow-token';
const TRAIN_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/deploy', deployRoutes);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res.status(err.getStatusCode()).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = createTestApp().listen(0, () =>
      resolve(listeningServer)
    );
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function post(path: string, body: unknown) {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WORKFLOW_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return {
      status: response.status,
      body: (await response.json()) as { error?: string }
    };
  });
}

function authorizeBody() {
  return {
    train_id: TRAIN_ID,
    operation_key: `${TRAIN_ID}:r1:deploy:backend:prod:api`,
    workflow_run_id: '12345',
    artifact_run_id: '54321',
    repository: 'backend',
    environment: 'prod',
    service: 'api',
    expected_sha: SHA,
    artifact_digest: DIGEST
  };
}

function matchingOperation() {
  return {
    train_id: TRAIN_ID,
    repository: 'backend',
    environment: 'prod',
    service: 'api',
    expected_sha: SHA,
    artifact_digest: null,
    status: 'DISPATCHED',
    request_metadata_json: { inputs: { artifact_run_id: '54321' } }
  };
}

function breakGlassBody() {
  return {
    workflow_run_id: '67890',
    repository: 'backend',
    environment: 'prod',
    service: 'api',
    expected_sha: SHA,
    reason: 'Emergency fix forward'
  };
}

describe('release-bus authorization routes', () => {
  beforeEach(() => {
    process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN = WORKFLOW_TOKEN;
    jest.clearAllMocks();
    mockFindOperation.mockResolvedValue(matchingOperation());
    mockGetLane.mockResolvedValue({
      train_id: TRAIN_ID,
      expires_at: Date.now() + 60_000
    });
    mockBindOperationAuthorization.mockResolvedValue(true);
    mockAppendEvent.mockResolvedValue(undefined);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      headSha: SHA,
      event: 'workflow_dispatch',
      name: 'Deploy a service',
      displayTitle: 'Deploy api to prod [manual]',
      actor: 'operator'
    });
    mockIsOrganizationOperator.mockResolvedValue(true);
    mockPauseForBreakGlass.mockResolvedValue(null);
  });

  afterAll(() => {
    delete process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN;
  });

  it('rejects an authorization request that does not match its operation', async () => {
    mockFindOperation.mockResolvedValue({
      ...matchingOperation(),
      expected_sha: 'c'.repeat(40)
    });

    const response = await post(
      '/deploy/release-bus/authorize',
      authorizeBody()
    );

    expect(response.status).toBe(403);
    expect(mockBindOperationAuthorization).not.toHaveBeenCalled();
  });

  it('rejects a workflow or digest that loses the atomic claim', async () => {
    mockBindOperationAuthorization.mockResolvedValue(false);

    const response = await post(
      '/deploy/release-bus/authorize',
      authorizeBody()
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('different workflow run or artifact');
  });

  it('rejects break glass when the exact workflow actor is not an operator', async () => {
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await post(
      '/deploy/release-bus/authorize-break-glass',
      breakGlassBody()
    );

    expect(response.status).toBe(403);
    expect(mockPauseForBreakGlass).not.toHaveBeenCalled();
  });

  it('does not authorize or audit break glass while a train is active', async () => {
    mockPauseForBreakGlass.mockResolvedValue({ id: 'active-train' });

    const response = await post(
      '/deploy/release-bus/authorize-break-glass',
      breakGlassBody()
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('lane was not paused');
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });
});
