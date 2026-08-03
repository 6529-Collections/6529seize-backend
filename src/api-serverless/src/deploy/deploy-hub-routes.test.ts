const mockGetViewer = jest.fn();
const mockIsOrganizationOperator = jest.fn();

jest.mock('@/api/deploy/deploy.github.service', () => ({
  gitHubDeployService: {
    getViewer: (...args: unknown[]) => mockGetViewer(...args),
    isOrganizationOperator: (...args: unknown[]) =>
      mockIsOrganizationOperator(...args)
  }
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import deployHubRoutes from '@/api/deploy/deploy-hub.routes';

const TOKEN = 'github-token-canary';

function createTestApp() {
  const app = express();
  app.use('/deploy/hub', deployHubRoutes);
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiCompliantException) {
      res.status(error.getStatusCode()).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error.message });
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

async function getSession(authorization?: string) {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/deploy/hub/session`, {
      headers: authorization ? { authorization } : undefined
    });
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      bodyText: await response.text()
    };
  });
}

describe('Deploy Hub GitHub authentication', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetViewer.mockResolvedValue({ login: 'prxt6529' });
    mockIsOrganizationOperator.mockResolvedValue(true);
  });

  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer token extra'])(
    'rejects a missing or malformed Bearer credential: %s',
    async (authorization) => {
      const response = await getSession(authorization);

      expect(response.status).toBe(401);
      expect(mockGetViewer).not.toHaveBeenCalled();
    }
  );

  it('derives the login from GitHub and checks the existing operator team', async () => {
    const response = await getSession(`Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.cacheControl).toContain('no-store');
    expect(JSON.parse(response.bodyText)).toEqual({ login: 'prxt6529' });
    expect(response.bodyText).not.toContain(TOKEN);
    expect(mockGetViewer).toHaveBeenCalledWith(TOKEN);
    expect(mockIsOrganizationOperator).toHaveBeenCalledWith(
      TOKEN,
      'prxt6529',
      '6529-Collections',
      'release-bus-operators'
    );
  });

  it('rejects a valid GitHub identity outside the deployment operator team', async () => {
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await getSession(`Bearer ${TOKEN}`);

    expect(response.status).toBe(403);
    expect(response.bodyText).not.toContain(TOKEN);
  });

  it('returns invalid-token failures without exposing the credential', async () => {
    mockGetViewer.mockRejectedValue(
      new CustomApiCompliantException(401, 'GitHub token is invalid')
    );

    const response = await getSession(`Bearer ${TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.bodyText).not.toContain(TOKEN);
    expect(mockIsOrganizationOperator).not.toHaveBeenCalled();
  });
});
