import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { getAuthenticationContext } from '@/api/auth/auth';
import { notificationsApiService } from '@/api/notifications/notifications.api.service';
import router from '@/api/notifications/notifications.routes';
import { AuthenticationContext } from '@/auth-context';
import { ApiCompliantException, apiCompliantErrorBody } from '@/exceptions';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next()
}));

jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn()
}));

jest.mock('@/api/notifications/notifications.api.service', () => ({
  notificationsApiService: {
    markAllNotificationsAsRead: jest.fn(),
    markNotificationAsRead: jest.fn()
  }
}));

describe('notification read routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api/notifications', router);
    app.use(
      (error: Error, _req: Request, res: Response, next: NextFunction) => {
        if (error instanceof ApiCompliantException) {
          res.status(error.getStatusCode()).send(apiCompliantErrorBody(error));
          return;
        }
        next(error);
      }
    );
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/notifications`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('viewer'));
  });

  it('marks all notifications as read at the canonical path', async () => {
    const response = await fetch(`${baseUrl}/read`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(
      notificationsApiService.markAllNotificationsAsRead
    ).toHaveBeenCalledWith('viewer', expect.any(Object));
  });

  it('rejects all as a notification ID without marking anything as read', async () => {
    const response = await fetch(`${baseUrl}/all/read`, { method: 'POST' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid notification id: all.'
    });
    expect(
      notificationsApiService.markAllNotificationsAsRead
    ).not.toHaveBeenCalled();
    expect(
      notificationsApiService.markNotificationAsRead
    ).not.toHaveBeenCalled();
  });
});
