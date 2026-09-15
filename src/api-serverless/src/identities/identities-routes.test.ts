import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import { ProfileClassification } from '@/entities/IProfile';

const mockSearchIdentities = jest.fn();
const authenticationContext = {
  authenticatedProfileId: null
};

jest.mock('../auth/auth', () => ({
  getAuthenticationContext: jest.fn().mockResolvedValue(authenticationContext),
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('./identities.service', () => ({
  identitiesService: {
    searchIdentities: mockSearchIdentities
  }
}));

jest.mock('./identity.fetcher', () => ({
  identityFetcher: {}
}));

jest.mock('./identities.activity.api.service', () => ({
  identitiesActivityApiService: {}
}));

jest.mock('@/api/request-cache', () => ({
  cacheRequest: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.mock('@/api/identity-mutes/identity-mutes.api.service', () => ({
  identityMutesApiService: {}
}));

import identitiesRoutes from './identities.routes';

function createTestApp() {
  const app = express();
  app.use('/identities', identitiesRoutes);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res.status(err.getStatusCode()).send({ error: err.message });
      return;
    }
    res.status(500).send({ error: 'Something went wrong...' });
  });
  return app;
}

async function withServer<T>(callback: (baseUrl: string) => Promise<T>) {
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

describe('identities search route', () => {
  beforeEach(() => {
    mockSearchIdentities.mockReset();
    mockSearchIdentities.mockResolvedValue([]);
  });

  it('lists identities without a handle and passes optional filters', async () => {
    await withServer(async (baseUrl) => {
      const query = new URLSearchParams({
        classification: ProfileClassification.ORGANIZATION,
        subclassification: '  Arts & Culture: Museum  '
      });
      const response = await fetch(`${baseUrl}/identities?${query}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(mockSearchIdentities).toHaveBeenCalledWith(
        {
          handle: null,
          limit: 20,
          wave_id: null,
          group_id: null,
          classification: ProfileClassification.ORGANIZATION,
          subclassification: 'Arts & Culture: Museum'
        },
        expect.objectContaining({ authenticationContext })
      );
    });
  });

  it('rejects a supplied handle shorter than three characters', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/identities?handle=ab`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Handle must be at least 3 characters.'
      });
      expect(mockSearchIdentities).not.toHaveBeenCalled();
    });
  });

  it('rejects an unsupported classification', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/identities?classification=UNKNOWN`
      );

      expect(response.status).toBe(400);
      expect(mockSearchIdentities).not.toHaveBeenCalled();
    });
  });
});
