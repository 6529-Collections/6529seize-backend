const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const createWebSessionMock = jest.fn();
const createNativeSessionMock = jest.fn();
const issueAccessTokenMock = jest.fn();
const storeLoginGrantMock = jest.fn();

jest.mock('../async.router', () => ({
  asyncRouter: () => ({
    get: mockRouterGet,
    post: mockRouterPost
  })
}));

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn()
}));

jest.mock('./auth', () => ({
  getAuthenticatedWalletOrNull: jest.fn(),
  getJwtSecret: () => 'auth-routes-session-records-test-secret',
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('./auth-session-v2', () => ({
  createConnectionShare: jest.fn(),
  createNativeSession: createNativeSessionMock,
  createWebSession: createWebSessionMock,
  hasActiveNativeSessionForAddressAndRole: jest.fn(),
  hasActiveWebSessionForAddressAndRole: jest.fn(),
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
    retrieveOrGenerateRefreshToken: jest.fn().mockResolvedValue('refresh'),
    redeemRefreshToken: jest.fn()
  }
}));

jest.mock('./auth-legacy-refresh', () => ({
  assertLegacyRefreshEnabled: jest.fn()
}));

jest.mock('../identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: jest.fn().mockResolvedValue(null)
  }
}));

jest.mock('../proxies/proxy.api.service', () => ({
  profileProxyApiService: {
    getProxyByGrantedByAndGrantedTo: jest.fn()
  }
}));

jest.mock('@/api/device-signing/device-grants.service', () => ({
  deviceGrantsService: { storeLoginGrant: storeLoginGrantMock }
}));

import { ethers } from 'ethers';
import { BadRequestException } from '@/exceptions';
import { clearSiweWalletAuthReplayCacheForTests } from '../wallet-signatures/siwe-wallet-auth';
import { clearStructuredWalletSignatureReplayCacheForTests } from '../wallet-signatures/structured-wallet-signatures';
import './auth.routes';

const DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const SESSION_ID = '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e';
const NATIVE_PURPOSE =
  'Purpose: Sign this message to authenticate with 6529. 6529.io never asks for this message in a web browser, only the 6529 Mobile app and API clients do.';
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

const nonceHandler = getRouteHandler(mockRouterGet, '/nonce');
const loginHandler = getRouteHandler(mockRouterPost, '/login');
const sessionNonceHandler = getRouteHandler(mockRouterGet, '/session-nonce');
const sessionLoginHandler = getRouteHandler(mockRouterPost, '/session-login');

describe('wallet auth session records', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_WALLET_CHAIN_ID;
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS;
    delete process.env.WEB_APP_ORIGIN;
    delete process.env.WEB_APP_ADDITIONAL_ORIGINS;
    clearSiweWalletAuthReplayCacheForTests();
    clearStructuredWalletSignatureReplayCacheForTests();
    createWebSessionMock.mockResolvedValue({
      setCookie: '6529_session=test; HttpOnly',
      response: { address: wallet.address.toLowerCase() },
      sessionId: SESSION_ID
    });
    createNativeSessionMock.mockResolvedValue({
      response: { address: wallet.address.toLowerCase() }
    });
    issueAccessTokenMock.mockReturnValue({ token: 'access-token' });
    storeLoginGrantMock.mockResolvedValue({ id: `0x${'f'.repeat(64)}` });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  async function sessionNonce(
    query: Record<string, unknown>,
    headers: { origin?: string; host?: string } = {}
  ) {
    const response = makeResponse();
    await sessionNonceHandler(
      makeRequest({
        query: { signer_address: wallet.address.toLowerCase(), ...query },
        host: 'api.6529.io',
        ...headers
      }),
      response
    );
    return response.send.mock.calls[0][0] as {
      signable_message: string;
      server_signature: string;
    };
  }

  async function sessionLogin(
    nonce: { signable_message: string; server_signature: string },
    clientType: string,
    origin?: string
  ) {
    const response = makeResponse();
    await sessionLoginHandler(
      makeRequest({
        body: {
          client_type: clientType,
          client_address: wallet.address,
          client_signature: await wallet.signMessage(nonce.signable_message),
          server_signature: nonce.server_signature
        },
        origin,
        host: 'api.6529.io'
      }),
      response
    );
    return response;
  }

  it('tells native signers that 6529.io never asks for this text in a browser', async () => {
    const nonce = await sessionNonce({ client_type: 'native' });

    expect(nonce.signable_message.split('\n')).toContain(NATIVE_PURPOSE);
  });

  it('keeps the desktop purpose unchanged', async () => {
    const nonce = await sessionNonce(
      { client_type: 'desktop' },
      { origin: 'http://localhost:43123' }
    );

    expect(nonce.signable_message).toContain(
      '\nPurpose: Sign this message to authenticate with 6529.'
    );
    expect(nonce.signable_message).not.toContain('never asks');
  });

  it('records the structured format, signed domain and request Origin of a native sign-in', async () => {
    const nonce = await sessionNonce({ client_type: 'native' });

    const response = await sessionLogin(nonce, 'native', 'https://6529.io');

    expect(response.status).toHaveBeenCalledWith(201);
    expect(createNativeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientType: 'native',
        origin: {
          signatureFormat: 'structured',
          signatureDomain: 'native',
          clientOrigin: null,
          requestOrigin: 'https://6529.io'
        }
      })
    );
  });

  it('records a native sign-in without an Origin header as having none', async () => {
    const nonce = await sessionNonce({ client_type: 'native' });

    await sessionLogin(nonce, 'native');

    expect(createNativeSessionMock.mock.calls[0][0].origin).toMatchObject({
      requestOrigin: null
    });
  });

  it('records the signed loopback origin of a desktop sign-in', async () => {
    const nonce = await sessionNonce(
      { client_type: 'desktop' },
      { origin: 'http://localhost:43123' }
    );

    await sessionLogin(nonce, 'desktop', 'http://localhost:43123');

    expect(createNativeSessionMock.mock.calls[0][0]).toMatchObject({
      clientType: 'desktop',
      origin: {
        signatureFormat: 'structured',
        signatureDomain: 'localhost:43123',
        clientOrigin: 'http://localhost:43123',
        requestOrigin: 'http://localhost:43123'
      }
    });
  });

  it('records a SIWE web sign-in and the session that stored its grant', async () => {
    const nonce = await sessionNonce(
      { device_key: DEVICE_KEY, device_key_type: 'ed25519' },
      { origin: 'https://6529.io' }
    );

    const response = await sessionLogin(nonce, 'web', 'https://6529.io');

    expect(response.status).toHaveBeenCalledWith(201);
    expect(createWebSessionMock.mock.calls[0][0]).toMatchObject({
      signatureFormat: 'siwe',
      clientOrigin: 'https://6529.io'
    });
    expect(storeLoginGrantMock.mock.calls[0][0].registration).toEqual({
      apiHost: 'api.6529.io',
      requestOrigin: 'https://6529.io',
      session: { clientType: 'web', binding: 'siwe', sessionId: SESSION_ID }
    });
  });

  it('still refuses a web challenge for the staging origin on the production API', async () => {
    const response = makeResponse();
    await expect(
      sessionNonceHandler(
        makeRequest({
          query: { signer_address: wallet.address.toLowerCase() },
          origin: 'https://staging.6529.io',
          host: 'api.6529.io'
        }),
        response
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marks /auth/login tokens as legacy plain-text sign-ins', async () => {
    const nonceResponse = makeResponse();
    await nonceHandler(
      makeRequest({ query: { signer_address: wallet.address } }),
      nonceResponse
    );
    const { nonce, server_signature } = nonceResponse.send.mock.calls[0][0];
    const response = makeResponse();

    await loginHandler(
      makeRequest({
        body: {
          server_signature,
          client_signature: await wallet.signMessage(nonce),
          client_address: wallet.address
        }
      }),
      response
    );

    expect(response.status).toHaveBeenCalledWith(201);
    expect(issueAccessTokenMock).toHaveBeenCalledWith(
      wallet.address.toLowerCase(),
      null,
      { clientType: 'legacy', binding: 'legacy_text', sessionId: null }
    );
  });
});

function makeRequest({
  query = {},
  body = {},
  origin,
  host
}: {
  readonly query?: Record<string, unknown>;
  readonly body?: Record<string, unknown>;
  readonly origin?: string;
  readonly host?: string;
}) {
  return {
    query,
    body,
    headers: {
      ...(origin ? { origin } : {}),
      ...(host ? { host } : {})
    },
    timer: undefined
  };
}

function makeResponse() {
  const response = {
    setHeader: jest.fn(),
    send: jest.fn(),
    status: jest.fn()
  };
  response.status.mockReturnValue(response);
  return response;
}

function getRouteHandler(
  mockRouterMethod: jest.Mock,
  path: string
): (...args: any[]) => any {
  const registration = mockRouterMethod.mock.calls.find(
    ([registeredPath]) => registeredPath === path
  );
  if (!registration) {
    throw new Error(`Route ${path} was not registered`);
  }
  return registration[registration.length - 1];
}
