const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const createWebSessionMock = jest.fn();
const createNativeSessionMock = jest.fn();
const getProfileIdByIdentityKeyMock = jest.fn();

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
  getJwtSecret: () => 'auth-routes-siwe-test-secret',
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('./auth-session-v2', () => ({
  clearWalletSessionCookieForAddressAndOrigin: jest.fn(),
  clearWalletSessionCookieForOrigin: jest.fn(),
  createConnectionShare: jest.fn(),
  createNativeSession: createNativeSessionMock,
  createWebSession: createWebSessionMock,
  hasActiveNativeSessionForAddressAndRole: jest.fn(),
  hasActiveWebSessionForAddressAndRole: jest.fn(),
  isAuthConnectionSharingEnabled: jest.fn().mockReturnValue(true),
  issueAccessToken: jest.fn(),
  logoutNativeSession: jest.fn(),
  logoutWebSession: jest.fn(),
  redeemConnectionShare: jest.fn(),
  refreshNativeSession: jest.fn(),
  refreshWebSessionForAddress: jest.fn()
}));

jest.mock('./auth.db', () => ({
  authDb: {
    retrieveOrGenerateRefreshToken: jest.fn(),
    redeemRefreshToken: jest.fn()
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

import { ethers } from 'ethers';
import * as jwt from 'jsonwebtoken';
import { SiweMessage } from 'siwe';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests,
  parseStructuredWalletSignatureMessage
} from '../wallet-signatures/structured-wallet-signatures';
import {
  clearSiweWalletAuthReplayCacheForTests,
  createSiweWebAuthChallenge,
  signSiweWebAuthChallenge
} from '../wallet-signatures/siwe-wallet-auth';
import './auth.routes';

const JWT_SECRET = 'auth-routes-siwe-test-secret';
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

const sessionNonceHandler = getRouteHandler(mockRouterGet, '/session-nonce');
const sessionLoginHandler = getRouteHandler(mockRouterPost, '/session-login');
const legacyLoginHandler = getRouteHandler(mockRouterPost, '/login');

describe('wallet auth SIWE routes', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_STRUCTURED_SIGNATURES_REQUIRED:
      process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED,
    AUTH_WALLET_CHAIN_ID: process.env.AUTH_WALLET_CHAIN_ID,
    AUTH_SIGNATURE_ALLOWED_DOMAINS: process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS,
    AUTH_SIGNATURE_ALLOWED_AUDIENCES:
      process.env.AUTH_SIGNATURE_ALLOWED_AUDIENCES,
    WEB_APP_ORIGIN: process.env.WEB_APP_ORIGIN,
    WEB_APP_ADDITIONAL_ORIGINS: process.env.WEB_APP_ADDITIONAL_ORIGINS
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    delete process.env.AUTH_WALLET_CHAIN_ID;
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS;
    delete process.env.AUTH_SIGNATURE_ALLOWED_AUDIENCES;
    delete process.env.WEB_APP_ORIGIN;
    delete process.env.WEB_APP_ADDITIONAL_ORIGINS;
    clearSiweWalletAuthReplayCacheForTests();
    clearStructuredWalletSignatureReplayCacheForTests();
    getProfileIdByIdentityKeyMock.mockResolvedValue(null);
    createWebSessionMock.mockResolvedValue({
      setCookie: '6529_session=test; HttpOnly',
      response: {
        token: 'web-access-token',
        token_expiry: 123
      }
    });
    createNativeSessionMock.mockResolvedValue({
      response: {
        token: 'native-access-token',
        token_expiry: 123,
        refresh_token: 'native-refresh-token',
        client_type: 'native'
      }
    });
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    jest.clearAllMocks();
  });

  it.each([
    ['https://6529.io', 'api.6529.io', '6529.io'],
    ['https://staging.6529.io', 'api.staging.6529.io', 'staging.6529.io']
  ])(
    'GET /session-nonce returns canonical SIWE for %s',
    (origin, host, expectedDomain) => {
      const response = makeResponse();

      sessionNonceHandler(
        makeRequest({
          query: {
            signer_address: wallet.address.toLowerCase(),
            client_type: 'web',
            chain_id: 137
          },
          origin,
          host
        }),
        response
      );

      const payload = response.send.mock.calls[0][0];
      const parsed = new SiweMessage(payload.signable_message);
      expect(parsed.prepareMessage()).toBe(payload.signable_message);
      expect(parsed).toMatchObject({
        scheme: 'https',
        domain: expectedDomain,
        address: wallet.address,
        uri: origin,
        version: '1',
        chainId: 1
      });
      expect(payload.server_signature).toEqual(expect.any(String));
    }
  );

  it.each([
    {
      name: 'missing Origin',
      origin: undefined,
      host: 'api.6529.io'
    },
    {
      name: 'untrusted Origin',
      origin: 'https://evil.example',
      host: 'api.6529.io'
    },
    {
      name: 'Origin credentials',
      origin: 'https://user:pass@6529.io',
      host: 'api.6529.io'
    },
    {
      name: 'Origin path',
      origin: 'https://6529.io/path',
      host: 'api.6529.io'
    }
  ])('GET /session-nonce rejects $name', ({ origin, host }) => {
    expect(() =>
      sessionNonceHandler(
        makeRequest({
          query: {
            signer_address: wallet.address,
            client_type: 'web',
            chain_id: 1
          },
          origin,
          host
        }),
        makeResponse()
      )
    ).toThrow();
  });

  it('GET /session-nonce fails closed on an unrecognized Host without using the production audience', () => {
    process.env.WEB_APP_ORIGIN = 'https://6529.io';

    expect(() =>
      sessionNonceHandler(
        makeRequest({
          query: {
            signer_address: wallet.address,
            client_type: 'web',
            chain_id: 1
          },
          origin: 'https://6529.io',
          host: 'untrusted-api.example'
        }),
        makeResponse()
      )
    ).toThrow('allowed API Host');
  });

  it.each([
    {
      clientType: 'native',
      origin: undefined,
      host: 'untrusted-api.example',
      expectedSessionType: 'native'
    },
    {
      clientType: 'desktop',
      origin: 'http://localhost:6529',
      host: 'localhost:3000',
      expectedSessionType: 'desktop'
    }
  ])(
    'GET /session-nonce preserves custom structured v2 for $clientType',
    ({ clientType, origin, host, expectedSessionType }) => {
      const response = makeResponse();

      sessionNonceHandler(
        makeRequest({
          query: {
            signer_address: wallet.address,
            client_type: clientType,
            chain_id: 1
          },
          origin,
          host
        }),
        response
      );

      const payload = response.send.mock.calls[0][0];
      expect(
        parseStructuredWalletSignatureMessage(payload.signable_message)
      ).toMatchObject({
        sessionType: expectedSessionType,
        chainId: 1
      });
      expect(payload.signable_message).toContain('Version: 2');
    }
  );

  it('POST /session-login accepts SIWE with unchanged web session cookies and response', async () => {
    const issued = issueWebChallenge();
    const response = makeResponse();
    const signature = await wallet.signMessage(issued.message);

    await sessionLoginHandler(
      makeRequest({
        body: sessionLoginBody({
          messageSignature: signature,
          serverSignature: issued.serverSignature,
          clientType: 'web'
        }),
        origin: 'https://6529.io',
        host: 'api.6529.io'
      }),
      response
    );

    expect(createWebSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: wallet.address.toLowerCase(),
        signatureDomain: '6529.io',
        clientOrigin: 'https://6529.io',
        apiHost: 'api.6529.io'
      })
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      '6529_session=test; HttpOnly'
    );
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.send).toHaveBeenCalledWith({
      token: 'web-access-token',
      token_expiry: 123
    });
  });

  it('accepts SIWE even when strict structured signatures are required', async () => {
    process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED = 'true';
    const issued = issueWebChallenge();
    const signature = await wallet.signMessage(issued.message);

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({
            messageSignature: signature,
            serverSignature: issued.serverSignature,
            clientType: 'web'
          }),
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).resolves.toBeUndefined();
  });

  it('does not consume SIWE on an Origin mismatch', async () => {
    process.env.WEB_APP_ADDITIONAL_ORIGINS = 'https://www.6529.io';
    const issued = issueWebChallenge();
    const signature = await wallet.signMessage(issued.message);
    const body = sessionLoginBody({
      messageSignature: signature,
      serverSignature: issued.serverSignature,
      clientType: 'web'
    });

    await expect(
      sessionLoginHandler(
        makeRequest({
          body,
          origin: 'https://www.6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).rejects.toThrow(
      'Wallet auth web session Origin does not match the signed challenge'
    );

    await expect(
      sessionLoginHandler(
        makeRequest({
          body,
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).resolves.toBeUndefined();
  });

  it('rejects SIWE for native without consuming the web challenge', async () => {
    const issued = issueWebChallenge();
    const signature = await wallet.signMessage(issued.message);
    const baseBody = {
      messageSignature: signature,
      serverSignature: issued.serverSignature
    };

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({ ...baseBody, clientType: 'native' }),
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).rejects.toThrow('SIWE wallet auth challenges require a web session');

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({ ...baseBody, clientType: 'web' }),
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).resolves.toBeUndefined();
  });

  it('accepts a valid outstanding legacy first_party_web challenge', async () => {
    const issuedAt = new Date();
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      audience: 'api.6529.io',
      domain: '6529.io',
      clientOrigin: 'https://6529.io',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + 5 * 60 * 1000),
      nonce: 'outstanding-legacy-web-challenge',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const signature = await wallet.signMessage(message);
    const serverSignature = jwt.sign(message, JWT_SECRET, {
      algorithm: 'HS256'
    });

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({
            messageSignature: signature,
            serverSignature,
            clientType: 'web'
          }),
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).resolves.toBeUndefined();
  });

  it('keeps native challenges bound to the matching custom Session Type', async () => {
    const issuedAt = new Date();
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      audience: 'api.6529.io',
      domain: 'native',
      sessionType: 'native',
      wallet: wallet.address,
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + 5 * 60 * 1000),
      nonce: 'native-session-challenge-nonce',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const signature = await wallet.signMessage(message);
    const serverSignature = jwt.sign(message, JWT_SECRET, {
      algorithm: 'HS256'
    });

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({
            messageSignature: signature,
            serverSignature,
            clientType: 'desktop'
          }),
          origin: 'http://localhost:6529',
          host: 'localhost:3000'
        }),
        makeResponse()
      )
    ).rejects.toThrow(
      'Wallet auth desktop sessions require a desktop structured signature'
    );

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({
            messageSignature: signature,
            serverSignature,
            clientType: 'native'
          }),
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).resolves.toBeUndefined();
    expect(createNativeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: wallet.address.toLowerCase(),
        clientType: 'native'
      })
    );
  });

  it('does not disguise session persistence failures as authentication failures', async () => {
    const issued = issueWebChallenge();
    const signature = await wallet.signMessage(issued.message);
    const persistenceError = new Error('session persistence failed');
    createWebSessionMock.mockRejectedValueOnce(persistenceError);

    await expect(
      sessionLoginHandler(
        makeRequest({
          body: sessionLoginBody({
            messageSignature: signature,
            serverSignature: issued.serverSignature,
            clientType: 'web'
          }),
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).rejects.toBe(persistenceError);
  });

  it('keeps the new object envelope outside legacy /auth/login', async () => {
    const issued = issueWebChallenge();
    const signature = await wallet.signMessage(issued.message);

    await expect(
      legacyLoginHandler(
        makeRequest({
          body: {
            client_address: wallet.address,
            client_signature: signature,
            server_signature: issued.serverSignature
          },
          origin: 'https://6529.io',
          host: 'api.6529.io'
        }),
        makeResponse()
      )
    ).rejects.toThrow('Authentication failed');
  });
});

function issueWebChallenge(): {
  readonly message: string;
  readonly serverSignature: string;
} {
  const challenge = createSiweWebAuthChallenge({
    address: wallet.address,
    clientOrigin: 'https://6529.io',
    chainId: 1
  });
  return {
    message: challenge.message,
    serverSignature: signSiweWebAuthChallenge({
      challenge,
      apiAudience: 'api.6529.io',
      jwtSecret: JWT_SECRET
    })
  };
}

function sessionLoginBody({
  messageSignature,
  serverSignature,
  clientType
}: {
  readonly messageSignature: string;
  readonly serverSignature: string;
  readonly clientType: 'web' | 'native' | 'desktop';
}) {
  return {
    client_type: clientType,
    client_address: wallet.address,
    client_signature: messageSignature,
    server_signature: serverSignature,
    signature_version: 2
  };
}

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

function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  Object.entries(originalEnv).forEach(([name, value]) => {
    if (value === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = value;
  });
}
