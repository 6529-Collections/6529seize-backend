import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ApiCompliantException, apiCompliantErrorBody } from '@/exceptions';

jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));
jest.mock('@/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null)
}));
jest.mock('@/api/auth/auth', () => ({
  ...jest.requireActual('@/api/auth/auth'),
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getAuthenticationContext: jest.fn().mockResolvedValue({})
}));
jest.mock('./drop-signed-events.service', () => ({
  ...jest.requireActual('./drop-signed-events.service'),
  dropSignedEventsService: {
    findForDrop: jest.fn(),
    findForDrops: jest.fn()
  }
}));

import dropsRoutes from '@/api/drops/drops.routes';
import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';
import { dropSignedEventsService } from './drop-signed-events.service';

const findForDrops = jest.mocked(dropSignedEventsService.findForDrops);
const findForDrop = jest.mocked(dropSignedEventsService.findForDrop);

/** The API's own mount order: the drops router comes before generated routes. */
function createTestApp() {
  const app = express();
  app.use('/drops', dropsRoutes);
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

async function get(path: string): Promise<{ status: number; body: any }> {
  const server = await new Promise<Server>((resolve) => {
    const listening = createTestApp().listen(0, '127.0.0.1', () =>
      resolve(listening)
    );
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /drops/signed-events', () => {
  const batch = {
    drops: [],
    grants: [],
    unavailable: ['a'],
    truncated_drop_ids: []
  };

  beforeEach(() => {
    findForDrops.mockReset();
    findForDrop.mockReset();
    findForDrops.mockResolvedValue(batch);
  });

  it('reaches the batch handler, not the drop-by-id route', async () => {
    const response = await get('/drops/signed-events?drop_ids=a,b,a');

    expect(response).toEqual({ status: 200, body: batch });
    expect(findForDrops).toHaveBeenCalledWith(['a', 'b'], expect.anything());
  });

  it.each([
    ['no drop_ids', '/drops/signed-events'],
    ['an empty drop_ids', '/drops/signed-events?drop_ids='],
    [
      'more than 50 ids',
      `/drops/signed-events?drop_ids=${Array.from(
        { length: 51 },
        (_, i) => `d${i}`
      ).join(',')}`
    ]
  ])('answers 400 for %s', async (_, path) => {
    const response = await get(path);

    expect(response.status).toBe(400);
    expect(findForDrops).not.toHaveBeenCalled();
  });

  it('leaves the single drop route in place', async () => {
    const single = {
      drop_id: 'drop-1',
      current_event_id: null,
      events: [],
      grants: []
    };
    findForDrop.mockResolvedValue(single);

    const response = await get('/drops/drop-1/signed-events');

    expect(response).toEqual({ status: 200, body: single });
    expect(findForDrop).toHaveBeenCalledWith('drop-1', expect.anything());
  });
});
