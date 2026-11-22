const mockWrite = jest.fn();
const mockConsolidationAddresses = jest.fn();
const mockGetNft = jest.fn();

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    })
  }
}));

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn(),
  evictRedisCacheForPathWithTimeout: jest.fn()
}));

jest.mock('@/api/auth/auth', () => {
  const { UnauthorisedException } = jest.requireActual('@/exceptions');
  return {
    needsAuthenticatedUser:
      () =>
      (
        req: { headers: Record<string, string>; user?: unknown },
        _res: unknown,
        next: (err?: unknown) => void
      ) => {
        const wallet = req.headers['x-test-wallet'];
        if (!wallet) {
          next(new UnauthorisedException('Needs authentication'));
          return;
        }
        req.user = { wallet };
        next();
      },
    getAuthenticatedWalletOrNull: (req: { user?: { wallet: string } }) =>
      req.user?.wallet.toLowerCase() ?? null,
    getWalletOrThrow: (req: { user: { wallet: string } }) =>
      req.user.wallet.toLowerCase()
  };
});

jest.mock('@/api/subscriptions/api.subscriptions.db', () => ({
  fetchConsolidationAddresses: mockConsolidationAddresses
}));
jest.mock('@/subscriptions-identity/records/subscription-writes', () => ({
  subscriptionChangeWriter: { write: mockWrite }
}));
jest.mock('@/api/subscriptions/api.subscriptions.allowlist', () => ({}));
jest.mock('@/api/distributions/api.distributions.service', () => ({
  populateDistribution: jest.fn()
}));
jest.mock('@/db-api', () => ({ fetchEns: jest.fn() }));
jest.mock('@/delegationsLoop/db.delegations', () => ({
  fetchAirdropAddressForConsolidationKey: jest.fn()
}));
jest.mock('@/nftsLoop/db.nfts', () => ({ getNft: mockGetNft }));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import router from '@/api/subscriptions/api.subscriptions.routes';

const WALLET = '0x00000000000000000000000000000000000000c1';
const KEY = WALLET;
const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const MEMES = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
const HEADER = 'eyJ0ZXN0Ijp0cnVlfQ';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', router);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res
        .status(err.getStatusCode())
        .send({ error: err.message, code: err.code });
      return;
    }
    res.status(500).send({ error: 'Something went wrong...' });
  });
  return app;
}

describe('subscription write routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = await new Promise<Server>((resolve) => {
      const listening = createTestApp().listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConsolidationAddresses.mockResolvedValue([WALLET]);
    mockGetNft.mockResolvedValue(null);
    mockWrite.mockResolvedValue({ consolidation_key: KEY, ok: true });
  });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ) =>
    fetch(`${baseUrl}/api/subscriptions/${KEY}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-wallet': WALLET,
        ...headers
      },
      body: JSON.stringify(body)
    });

  it.each([
    [
      'subscription-mode',
      { automatic: true },
      { type: 'subs.mode', automatic: true }
    ],
    [
      'subscribe-all-editions',
      { subscribe_all_editions: false },
      { type: 'subs.all-editions', all: false }
    ],
    [
      'subscription',
      { contract: CONTRACT, token_id: 581, subscribed: true },
      { type: 'subs.card', contract: MEMES, tokenId: 581, subscribed: true }
    ],
    [
      'subscription-count',
      { contract: CONTRACT, token_id: 581, count: 2 },
      { type: 'subs.count', contract: MEMES, tokenId: 581, count: 2 }
    ]
  ])(
    'hands POST %s to the change writer with the header and the session wallet',
    async (path, body, change) => {
      const response = await post(path, body, {
        'x-6529-signed-records': HEADER
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        consolidation_key: KEY,
        ok: true
      });
      expect(mockWrite).toHaveBeenCalledWith({
        routeKey: KEY,
        wallet: WALLET,
        walletInKey: true,
        signedRecords: HEADER,
        change
      });
    }
  );

  it('passes no header when none was sent', async () => {
    await post('subscription-mode', { automatic: false });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ signedRecords: undefined })
    );
  });

  it('keeps the route checks before the writer: another key, a bad body, a released card', async () => {
    // A wallet that is not one of the key's.
    expect(
      (
        await post(
          'subscription-mode',
          { automatic: true },
          { 'x-test-wallet': '0x00000000000000000000000000000000000000c2' }
        )
      ).status
    ).toBe(403);
    expect((await post('subscription-mode', { automatic: 'x' })).status).toBe(
      400
    );
    mockGetNft.mockResolvedValueOnce({ id: 581 });
    expect(
      (
        await post('subscription', {
          contract: CONTRACT,
          token_id: 581,
          subscribed: true
        })
      ).status
    ).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("hands a principal key on with walletInKey false, for the writer to check the wallet's identity", async () => {
    const principal = `0x${'c1'.padStart(64, '0')}`;
    mockConsolidationAddresses.mockResolvedValueOnce([]);
    const response = await fetch(
      `${baseUrl}/api/subscriptions/${principal}/subscription-mode`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-wallet': WALLET
        },
        body: JSON.stringify({ automatic: true })
      }
    );
    expect(response.status).toBe(201);
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ routeKey: principal, walletInKey: false })
    );
  });

  it("answers with the writer's refusal", async () => {
    mockWrite.mockRejectedValueOnce(
      new CustomApiCompliantException(
        409,
        'Subscription changes are signed now. Update the app and try again.',
        'SIGNED_RECORD_REQUIRED'
      )
    );
    const response = await post('subscription-mode', { automatic: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        'Subscription changes are signed now. Update the app and try again.',
      code: 'SIGNED_RECORD_REQUIRED'
    });
  });
});
