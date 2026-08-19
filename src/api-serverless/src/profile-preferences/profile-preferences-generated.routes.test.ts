import { Server } from 'node:http';

const mockGetProfilePreferences = jest.fn();
const mockPutProfilePreferences = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.mock('@/api/profile-preferences/profile-preferences.handlers', () => ({
  handleGetProfilePreferences: mockGetProfilePreferences,
  handlePutProfilePreferences: mockPutProfilePreferences
}));

import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';
import express from 'express';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(generatedOpenApiRoutes);
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

describe('profile preferences generated routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves the canonical GET endpoint', async () => {
    mockGetProfilePreferences.mockResolvedValue({
      direct_message_policy: 'EVERYONE',
      notification_level: 'ALL',
      notifications: {}
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/profile-preferences`);

      expect(response.status).toBe(200);
      expect(mockGetProfilePreferences).toHaveBeenCalledTimes(1);
    });
  });

  it('serves the canonical PUT endpoint', async () => {
    mockPutProfilePreferences.mockResolvedValue({
      direct_message_policy: 'PEOPLE_I_FOLLOW',
      notification_level: 'ESSENTIAL_ONLY',
      notifications: {}
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/profile-preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notification_level: 'ESSENTIAL_ONLY' })
      });

      expect(response.status).toBe(200);
      expect(mockPutProfilePreferences).toHaveBeenCalledTimes(1);
    });
  });
});
