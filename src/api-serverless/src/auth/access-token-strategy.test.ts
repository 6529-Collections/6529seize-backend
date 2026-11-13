import express, { NextFunction, Request, Response } from 'express';
import { ethers } from 'ethers';
import * as passport from 'passport';
import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import * as jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import { createAccessTokenStrategy } from './access-token-strategy';
import { issueAccessToken } from './auth-session-v2';
import { buildStructuredWalletSignatureMessage } from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  createSiweWebAuthChallenge,
  signSiweWebAuthChallenge
} from '@/api/wallet-signatures/siwe-wallet-auth';

jest.mock('passport', () => {
  const actual = jest.requireActual<typeof import('passport')>('passport');
  // Preserve inherited Passport methods through ts-jest's namespace interop.
  Object.defineProperty(actual, '__esModule', { value: true });
  return actual;
});

jest.mock('@/api/identities/identity.fetcher', () => ({ identityFetcher: {} }));
jest.mock('@/api/proxies/proxy.api.service', () => ({
  profileProxyApiService: {},
  isProxyActionActive: jest.fn()
}));
import {
  getAccessTokenSessionOrNull,
  getAuthenticatedWalletOrNull,
  getWalletOrThrow,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from './auth';

const WALLET = ethers.getAddress(`0x${'abcdef0123'.repeat(4)}`);
const ROLE = randomUUID();

describe('access token strategy', () => {
  const originalEnv = { ...process.env };
  let secret: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    secret = randomBytes(32).toString('hex');
    process.env.JWT_SECRET = secret;
    process.env.JWT_EXPIRY_SECONDS = '60';
    passport.use('jwt', createAccessTokenStrategy(secret));
    passport.use('anonymous', new AnonymousStrategy());

    const app = express();
    app.use(passport.initialize());
    app.get('/required', needsAuthenticatedUser(), (req, res) => {
      res.json({ wallet: getWalletOrThrow(req) });
    });
    app.get('/optional', maybeAuthenticatedUser(), (req, res) => {
      res.json({ wallet: getAuthenticatedWalletOrNull(req) });
    });
    app.get('/session', needsAuthenticatedUser(), (req, res) => {
      res.json({ session: getAccessTokenSessionOrNull(req) });
    });
    app.use(
      (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        res
          .status(
            error instanceof ApiCompliantException ? error.getStatusCode() : 500
          )
          .end();
      }
    );
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    passport.unuse('jwt');
    passport.unuse('anonymous');
    process.env = originalEnv;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  function call(path: string, token?: string) {
    return fetch(`${url}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  }

  const challengeTokens: [string, () => string][] = [
    ['a short login nonce', () => jwt.sign(randomUUID(), secret)],
    [
      'a login nonce message',
      () =>
        jwt.sign(
          `Please sign to confirm ownership of this address.\n${WALLET}\n${randomUUID()}`,
          secret
        )
    ],
    [
      'a structured login message',
      () =>
        jwt.sign(
          buildStructuredWalletSignatureMessage({
            kind: 'authentication',
            audience: 'api.6529.io',
            domain: '6529.io',
            wallet: WALLET.toLowerCase(),
            nonce: randomUUID(),
            action: 'login',
            purpose: 'Sign this message to authenticate with 6529.'
          }),
          secret
        )
    ],
    [
      'a web login challenge',
      () =>
        signSiweWebAuthChallenge({
          challenge: createSiweWebAuthChallenge({
            address: WALLET,
            clientOrigin: 'https://6529.io',
            chainId: 1
          }),
          apiAudience: 'api.6529.io',
          jwtSecret: secret
        })
    ]
  ];

  it.each([
    ['without a role', undefined],
    ['with a role', ROLE]
  ])('authenticates an issued access token %s', async (_, role) => {
    const { token } = issueAccessToken(WALLET, role);

    for (const path of ['/required', '/optional']) {
      const response = await call(path, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ wallet: WALLET.toLowerCase() });
    }
  });

  it('exposes the session claims of a session-v2 token', async () => {
    const sessionId = randomUUID();
    const { token } = issueAccessToken(WALLET, ROLE, {
      clientType: 'desktop',
      binding: 'structured',
      sessionId
    });

    const response = await call('/session', token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: { clientType: 'desktop', binding: 'structured', sessionId }
    });
  });

  it('marks tokens issued outside a session as legacy', async () => {
    const response = await call('/session', issueAccessToken(WALLET).token);

    expect(await response.json()).toEqual({
      session: { clientType: 'legacy', binding: null, sessionId: null }
    });
  });

  it('authenticates a token minted before the session claims existed', async () => {
    const token = jwt.sign(
      { id: randomUUID(), sub: WALLET.toLowerCase(), role: ROLE },
      secret,
      { expiresIn: 60 }
    );

    for (const path of ['/required', '/optional']) {
      const response = await call(path, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ wallet: WALLET.toLowerCase() });
    }
    expect(await (await call('/session', token)).json()).toEqual({
      session: null
    });
  });

  it('authenticates a token with session claim values it does not know', async () => {
    const token = jwt.sign(
      { id: randomUUID(), sub: WALLET.toLowerCase(), ct: 'robot', sb: 7 },
      secret,
      { expiresIn: 60 }
    );

    const response = await call('/required', token);

    expect(response.status).toBe(200);
    expect(await (await call('/session', token)).json()).toEqual({
      session: null
    });
  });

  it.each(challengeTokens)(
    'answers 401 on a required-auth route for %s',
    async (_, issue) => {
      const response = await call('/required', issue());

      expect(response.status).toBe(401);
    }
  );

  it.each(challengeTokens)(
    'treats the caller as anonymous on an optional-auth route for %s',
    async (_, issue) => {
      const response = await call('/optional', issue());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ wallet: null });
    }
  );

  it.each([
    ['an array payload', () => jwt.sign(JSON.stringify([WALLET]), secret)],
    [
      'no expiry',
      () => jwt.sign({ id: randomUUID(), sub: WALLET.toLowerCase() }, secret)
    ],
    [
      'a non-string role',
      () =>
        jwt.sign({ sub: WALLET.toLowerCase(), role: 1 }, secret, {
          expiresIn: 60
        })
    ],
    [
      'an issuer',
      () =>
        jwt.sign({ sub: WALLET.toLowerCase() }, secret, {
          expiresIn: 60,
          issuer: 'someone'
        })
    ],
    [
      'an audience',
      () =>
        jwt.sign({ sub: WALLET.toLowerCase() }, secret, {
          expiresIn: 60,
          audience: 'api.6529.io'
        })
    ],
    [
      'a challenge type',
      () =>
        jwt.sign(
          { sub: WALLET.toLowerCase(), challenge_type: 'wallet_auth' },
          secret,
          { expiresIn: 60 }
        )
    ],
    [
      'another algorithm',
      () =>
        jwt.sign({ sub: WALLET.toLowerCase() }, secret, {
          expiresIn: 60,
          algorithm: 'HS512'
        })
    ]
  ])('answers 401 for a signed token with %s', async (_, issue) => {
    const response = await call('/required', issue());

    expect(response.status).toBe(401);
  });

  it('answers 401 without a token on a required-auth route', async () => {
    expect((await call('/required')).status).toBe(401);
  });
});

describe('getAuthenticatedWalletOrNull', () => {
  function requestWithUser(user: unknown): Request {
    return { user } as unknown as Request;
  }

  it('returns null without an authenticated user', () => {
    expect(getAuthenticatedWalletOrNull(requestWithUser(undefined))).toBe(null);
  });

  it('returns the lowercase wallet', () => {
    expect(
      getAuthenticatedWalletOrNull(requestWithUser({ wallet: WALLET }))
    ).toBe(WALLET.toLowerCase());
  });

  it.each([
    ['a function', () => WALLET],
    ['a number', 1],
    ['an empty string', ''],
    ['a missing wallet', undefined]
  ])('rejects %s as the wallet with a 401', (_, wallet) => {
    let thrown: unknown;
    try {
      getAuthenticatedWalletOrNull(requestWithUser({ wallet }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiCompliantException);
    expect((thrown as ApiCompliantException).getStatusCode()).toBe(401);
  });
});
