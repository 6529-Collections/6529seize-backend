import express, { NextFunction, Request, Response } from 'express';
import { createServer, Server } from 'node:http';
import { AuthenticationContext } from '@/auth-context';
import { getAuthenticationContext } from '@/api/auth/auth';
import { waveQuickVoteApiService } from './wave-quick-vote.api.service';
import router from './wave-quick-vote.routes';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next()
}));
jest.mock('./wave-quick-vote.api.service', () => ({
  waveQuickVoteApiService: { findUndiscoveredDrop: jest.fn() }
}));

describe('legacy quick vote offset validation', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    const app = express();
    app.use('/waves', router);
    app.use(
      (error: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(400).json({ error: error.message });
      }
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test port');
    baseUrl = `http://127.0.0.1:${address.port}/waves/wave/undiscovered-drop`;
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
    jest
      .mocked(waveQuickVoteApiService.findUndiscoveredDrop)
      .mockResolvedValue({
        drop: null,
        total_count: 0,
        left_to_vote_in_current_round: 0
      });
  });

  it('coerces a query-string offset to a numeric native bind value', async () => {
    expect((await fetch(`${baseUrl}?skip=2`)).status).toBe(200);
    expect(waveQuickVoteApiService.findUndiscoveredDrop).toHaveBeenCalledWith(
      { waveId: 'wave', identityId: 'viewer', skip: 2 },
      expect.anything()
    );
  });

  it.each(['-1', '1.5', 'bad', '9007199254740992'])(
    'rejects invalid offset %s',
    async (skip) => {
      expect((await fetch(`${baseUrl}?skip=${skip}`)).status).toBe(400);
      expect(
        waveQuickVoteApiService.findUndiscoveredDrop
      ).not.toHaveBeenCalled();
    }
  );
});
