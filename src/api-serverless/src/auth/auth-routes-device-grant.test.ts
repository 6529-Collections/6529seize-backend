const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const createWebSessionMock = jest.fn();
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
  getJwtSecret: () => 'auth-routes-device-grant-test-secret',
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('./auth-session-v2', () => ({
  createConnectionShare: jest.fn(),
  createNativeSession: jest.fn(),
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
import { SiweMessage } from 'siwe';
import { clearSiweWalletAuthReplayCacheForTests } from '../wallet-signatures/siwe-wallet-auth';
import { clearStructuredWalletSignatureReplayCacheForTests } from '../wallet-signatures/structured-wallet-signatures';
import './auth.routes';

const DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);
const webSessionResponse = {
  address: wallet.address.toLowerCase(),
  access_token: 'web-access-token',
  client_type: 'web'
};
const storedGrant = { id: `0x${'f'.repeat(64)}`, device_label: 'Browser' };

const sessionNonceHandler = getRouteHandler(mockRouterGet, '/session-nonce');
const sessionLoginHandler = getRouteHandler(mockRouterPost, '/session-login');

describe('wallet auth device grants', () => {
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
      response: webSessionResponse
    });
    storeLoginGrantMock.mockResolvedValue(storedGrant);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  function requestNonce(query: Record<string, unknown>) {
    const response = makeResponse();
    sessionNonceHandler(
      makeRequest({
        query: { signer_address: wallet.address.toLowerCase(), ...query },
        origin: 'https://6529.io',
        host: 'api.6529.io'
      }),
      response
    );
    return response.send.mock.calls[0][0] as {
      signable_message: string;
      server_signature: string;
    };
  }

  async function login(
    nonce: { signable_message: string; server_signature: string },
    extraBody: Record<string, unknown> = {}
  ) {
    const response = makeResponse();
    await sessionLoginHandler(
      makeRequest({
        body: {
          client_type: 'web',
          client_address: wallet.address,
          client_signature: await wallet.signMessage(nonce.signable_message),
          server_signature: nonce.server_signature,
          ...extraBody
        },
        origin: 'https://6529.io',
        host: 'api.6529.io'
      }),
      response
    );
    return response;
  }

  describe('GET /session-nonce', () => {
    it('adds the device grant statement and URN for web clients', () => {
      const payload = requestNonce({
        client_type: 'web',
        device_key: DEVICE_KEY,
        device_key_type: 'ed25519',
        device_scopes: 'react,post'
      });

      const parsed = new SiweMessage(payload.signable_message);
      expect(parsed.resources).toHaveLength(1);
      expect(parsed.resources?.[0]).toMatch(
        new RegExp(
          `^urn:6529:device-grant:v1:ed25519:${DEVICE_KEY.slice(2)}:post\\.react:\\d+$`
        )
      );
      expect(parsed.statement).toContain('It may post and react.');
      expect(parsed.statement).toContain('(device key d75a9801...f707511a)');
    });

    it('uses the default scopes', () => {
      const payload = requestNonce({
        device_key: DEVICE_KEY,
        device_key_type: 'ed25519'
      });
      expect(payload.signable_message).toContain(':post.edit.delete.react:');
    });

    it('keeps the plain challenge without device params', () => {
      const payload = requestNonce({ client_type: 'web' });
      expect(payload.signable_message).not.toContain('Resources');
      expect(new SiweMessage(payload.signable_message).statement).toBe(
        'Sign in to 6529. This request does not create a blockchain transaction, cost gas, or approve tokens.'
      );
    });

    it.each([
      ['native', 'http://localhost:6529'],
      ['desktop', 'http://localhost:6529']
    ])('rejects device params for %s clients', (clientType, origin) => {
      expect(() =>
        sessionNonceHandler(
          makeRequest({
            query: {
              signer_address: wallet.address,
              client_type: clientType,
              device_key: DEVICE_KEY,
              device_key_type: 'ed25519'
            },
            origin,
            host: 'localhost:3000'
          }),
          makeResponse()
        )
      ).toThrow('Device grants are only available for web sessions');
    });

    it.each([
      ['a key without a type', { device_key: DEVICE_KEY }],
      ['a type without a key', { device_key_type: 'ed25519' }],
      ['scopes without a key', { device_scopes: 'post' }],
      [
        'an uppercase key',
        { device_key: DEVICE_KEY.toUpperCase(), device_key_type: 'ed25519' }
      ],
      [
        'a short key',
        { device_key: DEVICE_KEY.slice(0, -2), device_key_type: 'ed25519' }
      ],
      [
        'another key type',
        { device_key: DEVICE_KEY, device_key_type: 'secp256k1' }
      ],
      [
        'scopes without post',
        {
          device_key: DEVICE_KEY,
          device_key_type: 'ed25519',
          device_scopes: 'react'
        }
      ],
      [
        'duplicate scopes',
        {
          device_key: DEVICE_KEY,
          device_key_type: 'ed25519',
          device_scopes: 'post,post'
        }
      ],
      [
        'unknown scopes',
        {
          device_key: DEVICE_KEY,
          device_key_type: 'ed25519',
          device_scopes: 'post,admin'
        }
      ]
    ])('rejects %s', (_name, query) => {
      expect(() =>
        sessionNonceHandler(
          makeRequest({
            query: { signer_address: wallet.address, ...query },
            origin: 'https://6529.io',
            host: 'api.6529.io'
          }),
          makeResponse()
        )
      ).toThrow();
    });
  });

  describe('POST /session-login', () => {
    it('stores the verified grant and returns it with the session', async () => {
      const nonce = requestNonce({
        device_key: DEVICE_KEY,
        device_key_type: 'ed25519'
      });

      const response = await login(nonce, { device_label: 'Chrome on macOS' });

      const parsed = new SiweMessage(nonce.signable_message);
      expect(storeLoginGrantMock).toHaveBeenCalledWith(
        {
          terms: expect.objectContaining({
            deviceKey: DEVICE_KEY,
            scopes: ['post', 'edit', 'delete', 'react']
          }),
          message: nonce.signable_message,
          walletSignature: await wallet.signMessage(nonce.signable_message),
          wallet: wallet.address.toLowerCase(),
          domain: '6529.io',
          chainId: 1,
          issuedAt: new Date(parsed.issuedAt!),
          deviceLabel: 'Chrome on macOS'
        },
        expect.anything()
      );
      expect(storeLoginGrantMock.mock.invocationCallOrder[0]).toBeGreaterThan(
        createWebSessionMock.mock.invocationCallOrder[0]
      );
      expect(response.status).toHaveBeenCalledWith(201);
      expect(response.send).toHaveBeenCalledWith({
        ...webSessionResponse,
        device_grant: storedGrant
      });
    });

    it('logs in without a grant when storing it fails', async () => {
      storeLoginGrantMock.mockRejectedValue(new Error('db down'));
      const nonce = requestNonce({
        device_key: DEVICE_KEY,
        device_key_type: 'ed25519'
      });

      const response = await login(nonce);

      expect(response.status).toHaveBeenCalledWith(201);
      expect(response.send).toHaveBeenCalledWith(webSessionResponse);
    });

    it('does not store anything for a plain login', async () => {
      const response = await login(requestNonce({}), {
        device_label: 'ignored'
      });

      expect(storeLoginGrantMock).not.toHaveBeenCalled();
      expect(response.send).toHaveBeenCalledWith(webSessionResponse);
    });

    it('never stores a grant when the wallet signature does not verify', async () => {
      const nonce = requestNonce({
        device_key: DEVICE_KEY,
        device_key_type: 'ed25519'
      });
      const other = ethers.Wallet.createRandom();
      const contract = jest.fn().mockImplementation(() => ({
        isValidSignature: jest.fn().mockResolvedValue('0xffffffff')
      }));
      const contractSpy = jest
        .spyOn(ethers, 'Contract', 'get')
        .mockReturnValue(contract as unknown as typeof ethers.Contract);

      try {
        await expect(
          login(nonce, {
            client_signature: await other.signMessage(nonce.signable_message)
          })
        ).rejects.toThrow('Invalid client signature');
      } finally {
        contractSpy.mockRestore();
      }
      expect(storeLoginGrantMock).not.toHaveBeenCalled();
      expect(createWebSessionMock).not.toHaveBeenCalled();
    });

    it('never stores a grant for a replayed challenge', async () => {
      const nonce = requestNonce({
        device_key: DEVICE_KEY,
        device_key_type: 'ed25519'
      });
      await login(nonce);

      await expect(login(nonce)).rejects.toThrow(
        'Invalid or consumed wallet auth challenge'
      );
      expect(storeLoginGrantMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a device label longer than 64 characters', async () => {
      await expect(
        login(requestNonce({}), { device_label: 'a'.repeat(65) })
      ).rejects.toThrow();
      expect(createWebSessionMock).not.toHaveBeenCalled();
    });
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
