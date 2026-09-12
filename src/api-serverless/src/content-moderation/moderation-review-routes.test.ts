import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { AuthenticationContext } from '@/auth-context';
import { ApiCompliantException } from '@/exceptions';
import { env } from '@/env';
import { Timer } from '@/time';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import { moderationReviewService } from '@/content-moderation/moderation-review.service';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';

const mockAuthenticationContext = jest.fn();
jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockAuthenticationContext,
  maybeAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
  needsAuthenticatedUser:
    () => async (_req: Request, res: Response, next: NextFunction) => {
      const auth = await mockAuthenticationContext();
      if (!auth.isUserFullyAuthenticated()) {
        res.status(401).send({ error: 'Authentication required' });
        return;
      }
      next();
    }
}));

import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(generatedOpenApiRoutes);
  app.use(
    (
      error: ApiCompliantException,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res
        .status(error.getStatusCode?.() ?? 500)
        .send({ error: error.message, code: error.code });
    }
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test address');
    await run(`http://127.0.0.1:${address.port}/content-moderation/checks`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('moderation generated routes and private handlers', () => {
  const action = {
    action: 'ALLOW',
    reason: 'Reviewed exact content',
    expected_version: 1,
    idempotency_key: 'fa5d13ac-1a9d-4b90-bd96-ae4569ad24d8'
  };
  beforeEach(() => {
    jest
      .spyOn(env, 'getStringArray')
      .mockImplementation((key) =>
        key === 'DEVS_6529_MENTION_PROFILE_IDS'
          ? ['dev']
          : ['broader-moderator']
      );
    jest
      .spyOn(Timer, 'getFromRequest')
      .mockReturnValue(new Timer('moderation-route-test'));
    mockAuthenticationContext.mockResolvedValue(
      AuthenticationContext.fromProfileId('dev')
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it('resolves access and counts before the generic item route', async () => {
    const get = jest.spyOn(moderationReviewDb, 'get');
    const counts = jest.spyOn(moderationReviewDb, 'counts').mockResolvedValue({
      needs_review: 7,
      quarantined: 2,
      rejected_today: 1,
      evaluator_failures_today: 0
    });
    await withServer(async (base) => {
      const access = await fetch(`${base}/access`);
      expect(access.status).toBe(200);
      expect(await access.json()).toEqual({ developer: true });
      const response = await fetch(`${base}/counts`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ needs_review: 7 });
    });
    expect(get).not.toHaveBeenCalled();
    expect(counts).toHaveBeenCalledTimes(1);
  });
  it.each(['broader-moderator', 'proxy'])(
    'denies %s before every privileged handler reads private data',
    async (identity) => {
      mockAuthenticationContext.mockResolvedValue(
        identity === 'proxy'
          ? new AuthenticationContext({
              authenticatedWallet: null,
              authenticatedProfileId: 'delegate',
              roleProfileId: 'dev',
              activeProxyActions: []
            })
          : AuthenticationContext.fromProfileId(identity)
      );
      const reads = [
        jest.spyOn(moderationReviewDb, 'list'),
        jest.spyOn(moderationReviewDb, 'counts'),
        jest.spyOn(moderationReviewDb, 'get'),
        jest.spyOn(moderationReviewDb, 'reportForReview')
      ];
      await withServer(async (base) => {
        const access = await fetch(`${base}/access`);
        expect(await access.json()).toEqual({ developer: false });
        for (const suffix of [
          '',
          '/counts',
          '/private-id',
          '/report/private-id',
          '/profile/private-id',
          '/private-id/actions'
        ]) {
          const response = await fetch(
            `${base}${suffix}`,
            suffix.endsWith('/actions')
              ? {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(action)
                }
              : undefined
          );
          expect(response.status).toBe(403);
          expect(response.headers.get('cache-control')).toBe(
            'private, no-store'
          );
          expect(await response.text()).not.toContain('private-id');
        }
      });
      reads.forEach((read) => expect(read).not.toHaveBeenCalled());
    }
  );
  it('keeps authentication middleware on the capability endpoint', async () => {
    mockAuthenticationContext.mockResolvedValue(
      AuthenticationContext.notAuthenticated()
    );
    await withServer(async (base) =>
      expect((await fetch(`${base}/access`)).status).toBe(401)
    );
  });
  it.each([
    { idempotency_key: 'not-a-uuid' },
    { expected_version: 0 },
    { action: 'UNSUPPORTED' },
    { actor_profile_id: 'spoofed' },
    { reason: '' }
  ])(
    'rejects invalid action input %p before the action service',
    async (override) => {
      const save = jest.spyOn(moderationReviewService, 'action');
      await withServer(async (base) => {
        const response = await fetch(`${base}/private-id/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...action, ...override })
        });
        expect(response.status).toBe(400);
      });
      expect(save).not.toHaveBeenCalled();
    }
  );
  it('preserves null evidence, evaluation result and audit metadata in generated serialization', () => {
    for (const [type, field] of [
      ['ApiModerationCheckDetail', 'evidence'],
      ['ApiModerationEvaluation', 'result'],
      ['ApiModerationAudit', 'metadata']
    ]) {
      const serialized = ObjectSerializer.serialize(
        { [field]: null },
        type,
        ''
      );
      expect(
        ObjectSerializer.deserialize(serialized, type, '')[field]
      ).toBeNull();
    }
  });
});
