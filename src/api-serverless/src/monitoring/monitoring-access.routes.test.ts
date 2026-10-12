import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { AuthenticationContext } from '@/auth-context';
import { ApiCompliantException } from '@/exceptions';
import { DEV_TEAM_GROUP_ID } from '@/groups/dev-team-access';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { Timer } from '@/time';
import { Logger } from '@/logging';

const mockSentryOverview = jest.fn();
const mockSentryHistory = jest.fn();
jest.mock('./sentry-history', () => ({ getSentryHistory: mockSentryHistory }));
jest.mock('./sentry-overview', () => ({
  getSentryOverview: mockSentryOverview
}));
const mockAuthenticationContext = jest.fn();
jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockAuthenticationContext,
  maybeAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
  needsAuthenticatedUser:
    () => (req: Request, res: Response, next: NextFunction) => {
      if (req.headers.authorization !== 'Bearer test') {
        res.status(401).send();
        return;
      }
      next();
    }
}));

import monitoringAccessRoutes from './monitoring-access.routes';
import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';

const authHeaders = { Authorization: 'Bearer test' };

async function withServer(run: (base: string) => Promise<void>) {
  const app = express();
  app.use('/monitoring', monitoringAccessRoutes);
  app.use(generatedOpenApiRoutes);
  // A future handler with no endpoint-specific auth still inherits the guard.
  app.get('/monitoring/probe', (_req, res) => res.json({ reached: true }));
  app.use(
    (
      error: ApiCompliantException,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res.status(error.getStatusCode?.() ?? 500).json({
        error: error.message,
        code: error.code
      });
    }
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test address');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('monitoring section authorization', () => {
  beforeEach(() => {
    mockSentryHistory
      .mockReset()
      .mockResolvedValue({ status: 'ready', projects: [] });
    mockSentryOverview
      .mockReset()
      .mockResolvedValue({ status: 'ready', projects: [] });
    mockAuthenticationContext.mockResolvedValue(
      AuthenticationContext.fromProfileId('member')
    );
    jest
      .spyOn(Timer, 'getFromRequest')
      .mockReturnValue(new Timer('monitoring-test'));
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleForByIds')
      .mockResolvedValue([DEV_TEAM_GROUP_ID]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('protects the generated endpoint and future handlers before authentication', async () => {
    await withServer(async (base) => {
      for (const path of [
        '/monitoring/access',
        '/monitoring/sentry',
        '/monitoring/sentry/history',
        '/monitoring/probe'
      ]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
    });
    expect(
      userGroupsService.getGroupsUserIsEligibleForByIds
    ).not.toHaveBeenCalled();
    expect(mockSentryOverview).not.toHaveBeenCalled();
    expect(mockSentryHistory).not.toHaveBeenCalled();
  });

  it('allows members and returns only the access contract', async () => {
    await withServer(async (base) => {
      const response = await fetch(base + '/monitoring/access', {
        headers: authHeaders
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ access: true });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(
        (await fetch(base + '/monitoring/probe', { headers: authHeaders }))
          .status
      ).toBe(200);
    });
  });

  it('denies a signed-in non-member across the entire section', async () => {
    jest
      .mocked(userGroupsService.getGroupsUserIsEligibleForByIds)
      .mockResolvedValue([]);
    await withServer(async (base) => {
      for (const path of [
        '/monitoring/access',
        '/monitoring/sentry',
        '/monitoring/sentry/history',
        '/monitoring/probe'
      ]) {
        const response = await fetch(base + path, { headers: authHeaders });
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
    });
  });

  it('returns a sanitized error for provider failures', async () => {
    mockSentryOverview.mockRejectedValue(
      new Error('secret token and provider body')
    );
    await withServer(async (base) => {
      const response = await fetch(base + '/monitoring/sentry', {
        headers: authHeaders
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        error: 'Sentry monitoring is temporarily unavailable',
        code: 'MONITORING_SENTRY_UNAVAILABLE'
      });
    });
  });

  it('rejects proxy sessions before checking the proxied member', async () => {
    mockAuthenticationContext.mockResolvedValue(
      new AuthenticationContext({
        authenticatedWallet: 'delegate-wallet',
        authenticatedProfileId: 'delegate',
        roleProfileId: 'member',
        activeProxyActions: []
      })
    );
    await withServer(async (base) => {
      expect(
        (await fetch(base + '/monitoring/sentry', { headers: authHeaders }))
          .status
      ).toBe(403);
    });
    expect(
      userGroupsService.getGroupsUserIsEligibleForByIds
    ).not.toHaveBeenCalled();
    expect(mockSentryOverview).not.toHaveBeenCalled();
  });

  it.each(['/monitoring/sentry', '/monitoring/sentry/history'])(
    'rechecks membership before the cached snapshot at %s after removal',
    async (path) => {
      jest
        .mocked(userGroupsService.getGroupsUserIsEligibleForByIds)
        .mockResolvedValueOnce([DEV_TEAM_GROUP_ID])
        .mockResolvedValueOnce([]);
      await withServer(async (base) => {
        expect(
          (await fetch(base + path, { headers: authHeaders })).status
        ).toBe(200);
        expect(
          (await fetch(base + path, { headers: authHeaders })).status
        ).toBe(403);
      });
      expect(
        mockSentryOverview.mock.calls.length +
          mockSentryHistory.mock.calls.length
      ).toBe(1);
    }
  );

  it('sanitizes history errors and denies proxy access before collecting history', async () => {
    mockSentryHistory.mockRejectedValue(new Error('private provider context'));
    await withServer(async (base) => {
      const response = await fetch(base + '/monitoring/sentry/history', {
        headers: authHeaders
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Sentry history is temporarily unavailable',
        code: 'MONITORING_SENTRY_HISTORY_UNAVAILABLE'
      });
      mockAuthenticationContext.mockResolvedValue(
        new AuthenticationContext({
          authenticatedWallet: 'delegate-wallet',
          authenticatedProfileId: 'delegate',
          roleProfileId: 'member',
          activeProxyActions: []
        })
      );
      expect(
        (
          await fetch(base + '/monitoring/sentry/history', {
            headers: authHeaders
          })
        ).status
      ).toBe(403);
      expect(mockSentryHistory).toHaveBeenCalledTimes(1);
    });
  });

  it('fails closed and sanitizes membership lookup failures', async () => {
    jest.spyOn(Logger.get('MonitoringAccess'), 'error').mockImplementation();
    jest
      .mocked(userGroupsService.getGroupsUserIsEligibleForByIds)
      .mockRejectedValue(new Error('private database context'));
    await withServer(async (base) => {
      const response = await fetch(base + '/monitoring/access', {
        headers: authHeaders
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Monitoring access is temporarily unavailable',
        code: 'MONITORING_ACCESS_UNAVAILABLE'
      });
    });
  });

  it('fails closed when the authenticated profile cannot be loaded', async () => {
    jest.spyOn(Logger.get('MonitoringAccess'), 'error').mockImplementation();
    mockAuthenticationContext.mockRejectedValueOnce(
      new Error('private authentication database context')
    );
    await withServer(async (base) => {
      const response = await fetch(base + '/monitoring/access', {
        headers: authHeaders
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Monitoring access is temporarily unavailable',
        code: 'MONITORING_ACCESS_UNAVAILABLE'
      });
    });
    expect(
      userGroupsService.getGroupsUserIsEligibleForByIds
    ).not.toHaveBeenCalled();
    expect(mockSentryOverview).not.toHaveBeenCalled();
  });
});
