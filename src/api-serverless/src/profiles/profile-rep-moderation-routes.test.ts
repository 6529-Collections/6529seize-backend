import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { AuthenticationContext } from '@/auth-context';
import { ApiCompliantException } from '@/exceptions';
import { Timer } from '@/time';
import { profilesService } from '@/profiles/profiles.service';
import { abusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ratingsService } from '@/rates/ratings.service';
import { getAuthenticationContext } from '@/api/auth/auth';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  maybeAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
  needsAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next()
}));
jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

import router from './profile-rep.routes';
const mockAuthenticationContext = jest.mocked(getAuthenticationContext);

async function postRating(category: string) {
  const app = express();
  app.use(express.json());
  app.use('/profiles/:identity/rep', router);
  app.use(
    (
      error: ApiCompliantException,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res.status(error.getStatusCode?.() ?? 500).send({ error: error.message });
    }
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test address');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/profiles/0x1111111111111111111111111111111111111111/rep/rating`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 1, category })
      }
    );
    const body = await response.text();
    if (response.status === 500) throw new Error(body);
    return response.status;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('REP moderation before target creation', () => {
  beforeEach(() => {
    mockAuthenticationContext.mockResolvedValue(
      AuthenticationContext.fromProfileId('rater')
    );
    jest
      .spyOn(Timer, 'getFromRequest')
      .mockReturnValue(new Timer('rep-moderation-route-test'));
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['disallowed', 'reserved', 'unauthenticated'])(
    'does not create a missing target for a %s request',
    async (kind) => {
      if (kind === 'unauthenticated')
        mockAuthenticationContext.mockResolvedValue(
          AuthenticationContext.notAuthenticated()
        );
      const check = jest
        .spyOn(abusivenessCheckService, 'checkRepPhrase')
        .mockResolvedValue({
          status: 'DISALLOWED',
          explanation: 'Rejected',
          text: 'Test category',
          external_check_performed_at: new Date(0)
        });
      const lookup = jest
        .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
        .mockResolvedValue(null);
      const create = jest.spyOn(profilesService, 'createOrUpdateProfile');
      const update = jest.spyOn(ratingsService, 'updateRating');

      expect(
        await postRating(
          kind === 'reserved' ? 'Help6529 Credits' : 'Test category'
        )
      ).toBe(kind === 'unauthenticated' ? 404 : 400);
      expect(lookup).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      if (kind !== 'disallowed') expect(check).not.toHaveBeenCalled();
    }
  );

  it('creates a missing target and saves REP only after moderation allows the category', async () => {
    const check = jest
      .spyOn(abusivenessCheckService, 'checkRepPhrase')
      .mockResolvedValue({
        status: 'ALLOWED',
        explanation: null,
        text: 'Test category',
        external_check_performed_at: new Date(0)
      });
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue(null);
    const create = jest
      .spyOn(profilesService, 'createOrUpdateProfile')
      .mockResolvedValue({ id: 'target' } as Awaited<
        ReturnType<typeof profilesService.createOrUpdateProfile>
      >);
    const update = jest
      .spyOn(ratingsService, 'updateRating')
      .mockResolvedValue(undefined);

    expect(await postRating('Test category')).toBe(200);
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]!
    );
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ matter_target_id: 'target' }),
      expect.anything()
    );
  });
});
