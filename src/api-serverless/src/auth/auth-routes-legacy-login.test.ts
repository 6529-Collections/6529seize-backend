const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const getRedisClientMock = jest.fn();
const issueAccessTokenMock = jest.fn();
const retrieveOrGenerateRefreshTokenMock = jest.fn();
const redeemRefreshTokenMock = jest.fn();
const getProfileIdByIdentityKeyMock = jest.fn();
const getAuthenticatedWalletOrNullMock = jest.fn();
const hasActiveWebSessionForAddressAndRoleMock = jest.fn();

jest.mock('../async.router', () => ({
  asyncRouter: () => ({
    get: mockRouterGet,
    post: mockRouterPost
  })
}));

jest.mock('@/redis', () => ({
  getRedisClient: () => getRedisClientMock()
}));

jest.mock('./auth', () => ({
  getAuthenticatedWalletOrNull: getAuthenticatedWalletOrNullMock,
  getJwtSecret: () => 'auth-routes-legacy-login-test-secret',
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('./auth-session-v2', () => ({
  createConnectionShare: jest.fn(),
  createNativeSession: jest.fn(),
  createWebSession: jest.fn(),
  hasActiveNativeSessionForAddressAndRole: jest.fn(),
  hasActiveWebSessionForAddressAndRole:
    hasActiveWebSessionForAddressAndRoleMock,
  isAuthConnectionSharingEnabled: jest.fn().mockReturnValue(true),
  issueAccessToken: issueAccessTokenMock,
  logoutNativeSession: jest.fn(),
  logoutWebSession: jest.fn(),
  redeemConnectionShare: jest.fn(),
  refreshNativeSession: jest.fn(),
  refreshWebSessionForAddress: jest.fn()
}));

jest.mock('./auth.db', () => ({
  authDb: {
    retrieveOrGenerateRefreshToken: retrieveOrGenerateRefreshTokenMock,
    redeemRefreshToken: redeemRefreshTokenMock
  }
}));

jest.mock('./auth-legacy-refresh', () => ({
  assertLegacyRefreshEnabled: jest.fn()
}));

jest.mock('../identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: getProfileIdByIdentityKeyMock
  }
}));

jest.mock('../proxies/proxy.api.service', () => ({
  profileProxyApiService: {
    getProxyByGrantedByAndGrantedTo: jest.fn()
  }
}));

import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import * as jwt from 'jsonwebtoken';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests
} from '../wallet-signatures/structured-wallet-signatures';
import {
  resetStringFormTransitionForTests,
  STRING_FORM_LAST_ACCEPTED_AT_MS,
  STRING_FORM_TRANSITION_MS
} from './legacy-text-challenge';
import './auth.routes';

const JWT_SECRET = 'auth-routes-legacy-login-test-secret';
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Electron/30.0.0 Safari/537.36';
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);
// Before the last day the old challenge form is accepted, so the tests do
// not depend on the date they run.
const BASE_NOW_MS = STRING_FORM_LAST_ACCEPTED_AT_MS - 2 * 24 * 3600_000;

const nonceHandler = getRouteHandler(mockRouterGet, '/nonce');
const loginHandler = getRouteChain(mockRouterPost, '/login');
const redeemHandler = getRouteChain(mockRouterPost, '/redeem-refresh-token');
const legacyDesktopLinkHandler = getRouteChain(
  mockRouterPost,
  '/connection-share/legacy-desktop'
);

describe('legacy plain-text sign-in routes', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_LEGACY_TEXT_LOGIN_DISABLED:
      process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED,
    AUTH_STRUCTURED_SIGNATURES_REQUIRED:
      process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED,
    AUTH_WALLET_CHAIN_ID: process.env.AUTH_WALLET_CHAIN_ID,
    AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS:
      process.env.AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS,
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL
  };
  let nowMs: number;
  let stdoutWrite: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED;
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    delete process.env.AUTH_WALLET_CHAIN_ID;
    delete process.env.AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS;
    // No contract-wallet lookups over the network for wrong signatures.
    delete process.env.ETHEREUM_RPC_URL;
    nowMs = BASE_NOW_MS;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    getRedisClientMock.mockReturnValue(null);
    clearStructuredWalletSignatureReplayCacheForTests();
    resetStringFormTransitionForTests();
    getProfileIdByIdentityKeyMock.mockResolvedValue(null);
    issueAccessTokenMock.mockReturnValue({
      token: 'access-token',
      expiresAt: new Date(BASE_NOW_MS + 3600_000)
    });
    retrieveOrGenerateRefreshTokenMock.mockResolvedValue('legacy-refresh');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    restoreEnv(originalEnv);
  });

  it.each([true, false])(
    'GET /nonce (short_nonce=%s) returns a challenge that expires in five minutes',
    (shortNonce) => {
      const res = makeResponse();
      nonceHandler(
        makeRequest({
          query: {
            signer_address: wallet.address,
            short_nonce: String(shortNonce)
          }
        }),
        res
      );

      const { nonce, server_signature } = res.send.mock.calls[0][0];
      const payload = jwt.verify(server_signature, JWT_SECRET, {
        clockTimestamp: Math.floor(nowMs / 1000)
      }) as jwt.JwtPayload;
      expect(res.status).toHaveBeenCalledWith(200);
      expect(typeof server_signature).toBe('string');
      expect(payload).toEqual(
        expect.objectContaining({ challenge_type: 'legacy_nonce', nonce })
      );
      expect(payload.exp! - payload.iat!).toBe(300);
    }
  );

  it('gives slow signers the configured lifetime', async () => {
    process.env.AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS = '1800';
    const challenge = await issueChallenge();
    nowMs += 25 * 60_000;

    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).resolves.toBeUndefined();

    const late = await issueChallenge();
    nowMs += 31 * 60_000;
    await expect(
      loginHandler(loginRequest(late), makeResponse())
    ).rejects.toThrow('jwt expired');
  });

  it('signs in once with a current challenge and records the format', async () => {
    const challenge = await issueChallenge();
    const res = makeResponse();

    await loginHandler(loginRequest(challenge), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.send).toHaveBeenCalledWith({
      token: 'access-token',
      refresh_token: 'legacy-refresh'
    });
    expect(emittedMetrics()).toEqual([
      expect.objectContaining({
        Route: 'login',
        Format: 'text',
        Client: 'desktop',
        Outcome: 'ok'
      })
    ]);
    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).rejects.toThrow('Invalid or consumed wallet auth challenge');
  });

  it('refuses a challenge after its five minutes', async () => {
    const challenge = await issueChallenge();
    nowMs += 5 * 60_000 + 1000;

    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).rejects.toThrow('Authentication failed: jwt expired');
    expect(retrieveOrGenerateRefreshTokenMock).not.toHaveBeenCalled();
  });

  it('does not consume a challenge on a wrong signature', async () => {
    const challenge = await issueChallenge();
    const other = ethers.Wallet.createRandom();

    await expect(
      loginHandler(
        loginRequest({
          ...challenge,
          signature: await other.signMessage(challenge.message)
        }),
        makeResponse()
      )
    ).rejects.toThrow('Invalid client signature');
    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).resolves.toBeUndefined();
  });

  it('accepts an old-form challenge once during the transition, then refuses the form', async () => {
    const first = await issueOldFormChallenge();
    const second = await issueOldFormChallenge();

    await expect(
      loginHandler(loginRequest(first), makeResponse())
    ).resolves.toBeUndefined();
    await expect(
      loginHandler(loginRequest(first), makeResponse())
    ).rejects.toThrow('Invalid or consumed wallet auth challenge');

    nowMs += STRING_FORM_TRANSITION_MS;
    await expect(
      loginHandler(loginRequest(second), makeResponse())
    ).rejects.toThrow('Authentication failed: Sign-in challenge expired');
    expect(emittedMetrics().map((metric) => metric.Format)).toEqual([
      'text_previous_form',
      'text_previous_form',
      'text_previous_form'
    ]);
  });

  it('refuses an old-form challenge from the last accepted day on', async () => {
    nowMs = STRING_FORM_LAST_ACCEPTED_AT_MS;
    const challenge = await issueOldFormChallenge();

    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).rejects.toThrow('Sign-in challenge expired');
  });

  it('keeps structured messages on /auth/login working after the transition', async () => {
    nowMs += STRING_FORM_TRANSITION_MS * 4;
    const structured = await issueStructuredChallenge();

    await expect(
      loginHandler(loginRequest(structured), makeResponse())
    ).resolves.toBeUndefined();
    expect(emittedMetrics()).toEqual([
      expect.objectContaining({ Format: 'structured', Outcome: 'ok' })
    ]);
    await expect(
      loginHandler(loginRequest(structured), makeResponse())
    ).rejects.toThrow('Invalid client signature');
  });

  it('refuses plain text but keeps structured sign-in when the switch is on', async () => {
    const challenge = await issueChallenge();
    process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED = 'true';

    expect(() =>
      nonceHandler(
        makeRequest({ query: { signer_address: wallet.address } }),
        makeResponse()
      )
    ).toThrow('Plain-text sign-in is disabled');
    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).rejects.toThrow('Plain-text sign-in is disabled');
    await expect(
      loginHandler(
        loginRequest(await issueStructuredChallenge()),
        makeResponse()
      )
    ).resolves.toBeUndefined();
  });

  it('fails closed in production without Redis, like structured sign-in', async () => {
    const challenge = await issueChallenge();
    const structured = await issueStructuredChallenge();
    process.env.NODE_ENV = 'production';

    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).rejects.toThrow('Invalid or consumed wallet auth challenge');
    await expect(
      loginHandler(loginRequest(structured), makeResponse())
    ).rejects.toThrow('Invalid client signature');
  });

  it('uses Redis for single use when it is available', async () => {
    const keys = new Set<string>();
    getRedisClientMock.mockReturnValue({
      set: jest.fn(async (key: string) => {
        if (keys.has(key)) {
          return null;
        }
        keys.add(key);
        return 'OK';
      }),
      get: jest.fn()
    });
    process.env.NODE_ENV = 'production';
    const challenge = await issueChallenge();

    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).resolves.toBeUndefined();
    await expect(
      loginHandler(loginRequest(challenge), makeResponse())
    ).rejects.toThrow('Invalid or consumed wallet auth challenge');
  });

  it('records refresh-token redemption outcomes', async () => {
    redeemRefreshTokenMock.mockResolvedValueOnce({
      address: wallet.address.toLowerCase(),
      role: null
    });
    await redeemHandler(
      makeRequest({ body: { token: 'legacy-refresh' } }),
      makeResponse()
    );
    redeemRefreshTokenMock.mockResolvedValueOnce(null);
    await expect(
      redeemHandler(makeRequest({ body: { token: 'unknown' } }), makeResponse())
    ).rejects.toThrow('Invalid refresh token');

    expect(
      emittedMetrics().map(({ Route, Format, Outcome }) => ({
        Route,
        Format,
        Outcome
      }))
    ).toEqual([
      { Route: 'redeem_refresh_token', Format: 'refresh_token', Outcome: 'ok' },
      {
        Route: 'redeem_refresh_token',
        Format: 'refresh_token',
        Outcome: 'refused'
      }
    ]);
  });

  it('records legacy desktop link use', async () => {
    getAuthenticatedWalletOrNullMock.mockReturnValue(wallet.address);
    hasActiveWebSessionForAddressAndRoleMock.mockResolvedValue(true);
    const res = makeResponse();

    await legacyDesktopLinkHandler(
      makeRequest({ body: {}, origin: 'https://6529.io' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(emittedMetrics()).toEqual([
      expect.objectContaining({
        Route: 'legacy_desktop_link',
        Client: 'desktop',
        Outcome: 'ok'
      })
    ]);
    const metricText = stdoutWrite.mock.calls.join('');
    expect(metricText).not.toContain(wallet.address.toLowerCase().slice(2));
    expect(metricText).not.toContain('legacy-refresh');
  });

  function emittedMetrics(): Record<string, unknown>[] {
    return stdoutWrite.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('6529.legacy_auth_use.v1'))
      .map((line) => JSON.parse(line));
  }
});

interface IssuedChallenge {
  readonly message: string;
  readonly signature: string;
  readonly serverSignature: string;
}

async function issueChallenge(): Promise<IssuedChallenge> {
  const res = makeResponse();
  nonceHandler(makeRequest({ query: { signer_address: wallet.address } }), res);
  const { nonce, server_signature } = res.send.mock.calls[0][0];
  return {
    message: nonce,
    signature: await wallet.signMessage(nonce),
    serverSignature: server_signature
  };
}

/** A challenge as builds before this one issued it: the text as the payload. */
async function issueOldFormChallenge(): Promise<IssuedChallenge> {
  const message = `old-form challenge ${Math.random()}`;
  return {
    message,
    signature: await wallet.signMessage(message),
    serverSignature: jwt.sign(message, JWT_SECRET)
  };
}

async function issueStructuredChallenge(): Promise<IssuedChallenge> {
  const issuedAt = new Date(Date.now());
  const message = buildStructuredWalletSignatureMessage({
    kind: 'authentication',
    audience: 'api.6529.io',
    domain: 'native',
    sessionType: 'native',
    wallet: wallet.address,
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + 5 * 60 * 1000),
    nonce: `structured-${Math.random().toString(36).slice(2)}`,
    action: 'login',
    purpose: 'Sign this message to authenticate with 6529.'
  });
  return {
    message,
    signature: await wallet.signMessage(message),
    serverSignature: jwt.sign(message, JWT_SECRET)
  };
}

function loginRequest(challenge: IssuedChallenge) {
  return makeRequest({
    body: {
      server_signature: challenge.serverSignature,
      client_signature: challenge.signature,
      client_address: wallet.address
    },
    userAgent: DESKTOP_USER_AGENT
  });
}

function makeRequest({
  query = {},
  body = {},
  origin,
  userAgent = DESKTOP_USER_AGENT
}: {
  readonly query?: Record<string, unknown>;
  readonly body?: Record<string, unknown>;
  readonly origin?: string;
  readonly userAgent?: string;
}) {
  return {
    query,
    body,
    headers: {
      'user-agent': userAgent,
      ...(origin ? { origin } : {})
    },
    timer: undefined
  };
}

/** An Express-like response: `send` and a thrown error both finish it. */
function makeResponse() {
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    locals: {} as Record<string, unknown>,
    setHeader: jest.fn(),
    send: jest.fn(),
    status: jest.fn()
  });
  response.status.mockImplementation((code: number) => {
    response.statusCode = code;
    return response;
  });
  response.send.mockImplementation(() => {
    response.emit('finish');
    return response;
  });
  return response;
}

function getRouteRegistration(mockRouterMethod: jest.Mock, path: string) {
  const registration = mockRouterMethod.mock.calls.find(
    ([registeredPath]) => registeredPath === path
  );
  if (!registration) {
    throw new Error(`Route ${path} was not registered`);
  }
  return registration.slice(1) as ((...args: any[]) => any)[];
}

function getRouteHandler(
  mockRouterMethod: jest.Mock,
  path: string
): (...args: any[]) => any {
  return getRouteRegistration(mockRouterMethod, path).at(-1)!;
}

/** Runs the route's middleware, then its handler, as Express would. */
function getRouteChain(
  mockRouterMethod: jest.Mock,
  path: string
): (req: unknown, res: ReturnType<typeof makeResponse>) => Promise<void> {
  const chain = getRouteRegistration(mockRouterMethod, path);
  return async (req, res) => {
    try {
      for (const middleware of chain.slice(0, -1)) {
        await new Promise<void>((resolve) => middleware(req, res, resolve));
      }
      await chain.at(-1)!(req, res);
    } catch (error: any) {
      res.statusCode = error?.getStatusCode?.() ?? 500;
      res.emit('finish');
      throw error;
    }
  };
}

function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  Object.entries(originalEnv).forEach(([name, value]) => {
    if (value === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = value;
  });
}
