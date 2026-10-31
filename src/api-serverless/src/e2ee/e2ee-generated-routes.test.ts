import { Server } from 'node:http';
import { NextFunction, Request, Response } from 'express';

jest.mock('@/api/auth/auth', () => ({
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getAuthenticationContext: jest.fn()
}));

import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiCompliantException, apiCompliantErrorBody } from '@/exceptions';
import express from 'express';

const HEX32 = `0x${'ab'.repeat(32)}`;

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(generatedOpenApiRoutes);
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res.status(err.getStatusCode()).send(apiCompliantErrorBody(err));
      return;
    }
    next(err);
  });
  return app;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = createTestApp();
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('E2EE generated routes', () => {
  const originalFlag = process.env.E2EE_DMS_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.E2EE_DMS_ENABLED;
    else process.env.E2EE_DMS_ENABLED = originalFlag;
    jest.clearAllMocks();
  });

  it.each([
    ['GET', '/e2ee/me'],
    ['POST', '/e2ee/devices'],
    ['GET', `/e2ee/devices/${HEX32}`],
    ['POST', `/e2ee/groups/${HEX32}/entries`],
    ['GET', `/e2ee/groups/${HEX32}/log?device_key=${HEX32}`],
    ['POST', `/e2ee/groups/${HEX32}/messages`],
    ['PUT', `/e2ee/blobs/0x${'1'.repeat(32)}/chunks/0`],
    ['POST', '/e2ee/reports']
  ])(
    'answers %s %s with 404 E2EE_DISABLED while the flag is off',
    async (method, path) => {
      process.env.E2EE_DMS_ENABLED = 'false';
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : '{}'
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: 'Encrypted messaging is not available',
          code: 'E2EE_DISABLED'
        });
      });
      expect(getAuthenticationContext).not.toHaveBeenCalled();
    }
  );

  it('rejects proxies and callers without a profile when enabled', async () => {
    process.env.E2EE_DMS_ENABLED = 'true';
    const mocked = jest.mocked(getAuthenticationContext);
    mocked.mockResolvedValueOnce({
      isAuthenticatedAsProxy: () => true,
      getActingAsId: () => 'someone'
    } as never);
    mocked.mockResolvedValueOnce({
      isAuthenticatedAsProxy: () => false,
      getActingAsId: () => null
    } as never);
    await withServer(async (baseUrl) => {
      const proxy = await fetch(`${baseUrl}/e2ee/me`);
      expect(proxy.status).toBe(403);
      expect(((await proxy.json()) as { code: string }).code).toBe(
        'E2EE_FORBIDDEN'
      );
      const noProfile = await fetch(`${baseUrl}/e2ee/me`);
      expect(noProfile.status).toBe(403);
      expect(((await noProfile.json()) as { code: string }).code).toBe(
        'E2EE_FORBIDDEN'
      );
    });
  });

  it('rejects malformed path parameters with E2EE_BAD_REQUEST', async () => {
    process.env.E2EE_DMS_ENABLED = 'true';
    jest.mocked(getAuthenticationContext).mockResolvedValue({
      isAuthenticatedAsProxy: () => false,
      getActingAsId: () => 'profile-1'
    } as never);
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/e2ee/devices/not-a-key`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe(
        'E2EE_BAD_REQUEST'
      );
    });
  });

  it('keeps trust-and-safety reads closed until a group is configured, flag or not', async () => {
    process.env.E2EE_DMS_ENABLED = 'false';
    const originalGroup = process.env.E2EE_TRUST_AND_SAFETY_GROUP_ID;
    delete process.env.E2EE_TRUST_AND_SAFETY_GROUP_ID;
    const mocked = jest.mocked(getAuthenticationContext);
    mocked.mockResolvedValueOnce({
      isAuthenticatedAsProxy: () => true,
      getActingAsId: () => 'someone'
    } as never);
    mocked.mockResolvedValue({
      isAuthenticatedAsProxy: () => false,
      getActingAsId: () => 'profile-1'
    } as never);
    try {
      await withServer(async (baseUrl) => {
        const proxy = await fetch(`${baseUrl}/e2ee/trust-and-safety/reports`);
        expect(proxy.status).toBe(403);
        const unconfigured = await fetch(
          `${baseUrl}/e2ee/trust-and-safety/reports`
        );
        expect(unconfigured.status).toBe(403);
        expect(await unconfigured.json()).toEqual({
          error: 'Trust and safety review is not configured',
          code: 'E2EE_FORBIDDEN'
        });
        const badId = await fetch(
          `${baseUrl}/e2ee/trust-and-safety/reports/not-an-id`
        );
        expect(badId.status).toBe(400);
        const cursorWithoutTime = await fetch(
          `${baseUrl}/e2ee/trust-and-safety/reports?before_id=0x${'0'.repeat(32)}`
        );
        expect(cursorWithoutTime.status).toBe(400);
      });
    } finally {
      if (originalGroup === undefined) {
        delete process.env.E2EE_TRUST_AND_SAFETY_GROUP_ID;
      } else {
        process.env.E2EE_TRUST_AND_SAFETY_GROUP_ID = originalGroup;
      }
    }
  });
});
