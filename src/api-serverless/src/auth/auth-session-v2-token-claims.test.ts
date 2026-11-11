import * as jwt from 'jsonwebtoken';
import { authDb } from './auth.db';
import { identitiesDb } from '@/identities/identities.db';
import type { WalletAuthSessionEntity } from '@/entities/IWalletAuthSession';
import {
  createNativeSession,
  createWebSession,
  issueAccessToken,
  redeemConnectionShare,
  refreshNativeSession,
  refreshWebSession
} from './auth-session-v2';

jest.mock('./auth.db', () => ({
  authDb: {
    createWalletAuthSession: jest.fn(),
    getActiveNativeSessionByRefreshHash: jest.fn(),
    getActiveWebSessionById: jest.fn(),
    getActiveWebSessionBySecretHash: jest.fn(),
    rotateNativeSessionRefreshToken: jest.fn(),
    rotateWebSessionSecret: jest.fn(),
    consumeWalletConnectionShare: jest.fn(),
    markWalletConnectionShareSession: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(async (fn) =>
      fn({ connection: { id: 'tx' } })
    )
  }
}));

jest.mock('@/identities/identities.db', () => ({
  identitiesDb: { getProfileIdByWallet: jest.fn() }
}));

const authDbMock = authDb as jest.Mocked<typeof authDb>;

const SESSION_ID = '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e';

function claimsOf(token: string): Record<string, unknown> {
  return jwt.verify(token, 'test-jwt-secret') as Record<string, unknown>;
}

function storedRow(
  params: Parameters<typeof authDb.createWalletAuthSession>[0]
): WalletAuthSessionEntity {
  return {
    id: params.id,
    address: params.address,
    role: params.role,
    client_type: params.clientType,
    secret_hash: params.secretHash,
    refresh_token_hash: params.refreshTokenHash,
    user_agent_hash: params.userAgentHash,
    signature_domain: params.signatureDomain,
    client_origin: params.clientOrigin,
    signature_format: params.signatureFormat ?? null,
    request_origin: params.requestOrigin ?? null,
    created_at: new Date(),
    last_used_at: new Date(),
    expires_at: params.expiresAt,
    revoked_at: null
  };
}

function sessionRow(
  overrides: Partial<WalletAuthSessionEntity>
): WalletAuthSessionEntity {
  return {
    id: SESSION_ID,
    address: '0xabc',
    role: 'profile-1',
    client_type: 'native',
    secret_hash: null,
    refresh_token_hash: 'old-hash',
    user_agent_hash: null,
    signature_domain: null,
    client_origin: null,
    created_at: new Date(),
    last_used_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
    ...overrides
  };
}

describe('session-v2 access token claims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(identitiesDb.getProfileIdByWallet)
      .mockResolvedValue('profile-1');
    authDbMock.createWalletAuthSession.mockImplementation(async (params) =>
      storedRow(params)
    );
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_EXPIRY_SECONDS = '900';
    process.env.AUTH_SESSION_HASH_SECRET = 'test-session-hash-secret';
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRY_SECONDS;
    delete process.env.AUTH_SESSION_HASH_SECRET;
  });

  it('marks tokens issued without a session as legacy', () => {
    const claims = claimsOf(issueAccessToken('0xABC', 'profile-1').token);
    expect(claims).toMatchObject({
      sub: '0xabc',
      role: 'profile-1',
      ct: 'legacy'
    });
    expect(claims).not.toHaveProperty('sb');
    expect(claims).not.toHaveProperty('sid');
  });

  it('stores a SIWE web session with its format and Origin, and says so in the token', async () => {
    const created = await createWebSession({
      address: '0xABC',
      role: null,
      userAgent: null,
      signatureDomain: '6529.io',
      clientOrigin: 'https://6529.io',
      apiHost: 'api.6529.io',
      signatureFormat: 'siwe'
    });

    const [stored] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(stored).toMatchObject({
      clientType: 'web',
      signatureFormat: 'siwe',
      requestOrigin: 'https://6529.io'
    });
    expect(created.sessionId).toBe(stored.id);
    expect(claimsOf(created.response.access_token)).toMatchObject({
      ct: 'web',
      sb: 'siwe',
      sid: stored.id
    });
  });

  it('stores what a structured app sign-in signed and the request Origin', async () => {
    const created = await createNativeSession({
      address: '0xABC',
      role: null,
      userAgent: null,
      clientType: 'desktop',
      origin: {
        signatureFormat: 'structured',
        signatureDomain: 'localhost:43123',
        clientOrigin: 'http://localhost:43123',
        requestOrigin: 'http://localhost:43123'
      }
    });

    const [stored] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(stored).toMatchObject({
      clientType: 'desktop',
      signatureFormat: 'structured',
      signatureDomain: 'localhost:43123',
      clientOrigin: 'http://localhost:43123',
      requestOrigin: 'http://localhost:43123'
    });
    expect(claimsOf(created.response.access_token)).toMatchObject({
      ct: 'desktop',
      sb: 'structured',
      sid: stored.id
    });
  });

  it('keeps recording nothing extra for callers that pass no origin', async () => {
    await createNativeSession({
      address: '0xABC',
      role: null,
      userAgent: null
    });

    const [stored] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(stored.signatureDomain).toBeNull();
    expect(stored.clientOrigin).toBeNull();
    expect(stored.signatureFormat).toBeNull();
    expect(stored.requestOrigin).toBeNull();
  });

  it('keeps the client type and binding of a web session across a refresh', async () => {
    const webRow = sessionRow({
      client_type: 'web',
      secret_hash: 'hash',
      refresh_token_hash: null,
      signature_domain: '6529.io',
      client_origin: 'https://6529.io',
      signature_format: 'siwe'
    });
    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValue(webRow);
    authDbMock.rotateWebSessionSecret.mockResolvedValue(webRow);

    const refreshed = await refreshWebSession({
      cookie: { sessionId: SESSION_ID, secret: 'secret' },
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(claimsOf(refreshed!.response.access_token)).toMatchObject({
      ct: 'web',
      sb: 'siwe',
      sid: SESSION_ID
    });
  });

  it('refreshes a session stored before the format was recorded without a binding', async () => {
    const oldRow = sessionRow({});
    authDbMock.getActiveNativeSessionByRefreshHash.mockResolvedValue(oldRow);
    authDbMock.rotateNativeSessionRefreshToken.mockImplementation(
      async (params) =>
        sessionRow({ refresh_token_hash: params.nextRefreshTokenHash })
    );

    const refreshed = await refreshNativeSession({
      address: '0xABC',
      nativeRefreshToken: 'raw-native-refresh-token'
    });

    const claims = claimsOf(refreshed!.response.access_token);
    expect(claims).toMatchObject({ ct: 'native', sid: SESSION_ID });
    expect(claims).not.toHaveProperty('sb');
  });

  it('keeps the share binding of a redeemed session across a refresh', async () => {
    authDbMock.getActiveNativeSessionByRefreshHash.mockResolvedValue(
      sessionRow({ signature_format: 'share' })
    );
    authDbMock.rotateNativeSessionRefreshToken.mockImplementation(
      async (params) =>
        sessionRow({
          refresh_token_hash: params.nextRefreshTokenHash,
          signature_format: 'share'
        })
    );

    const refreshed = await refreshNativeSession({
      address: '0xABC',
      nativeRefreshToken: 'raw-native-refresh-token'
    });

    expect(claimsOf(refreshed!.response.access_token)).toMatchObject({
      ct: 'native',
      sb: 'share'
    });
  });

  it('records a redeemed connection share as a share session', async () => {
    authDbMock.consumeWalletConnectionShare.mockResolvedValue({
      id: 'share-1',
      connection_share_code_hash: 'hashed-share',
      encrypted_device_setup: null,
      address: '0xabc',
      role: 'profile-1',
      target_client_type: 'desktop',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: new Date(),
      consumed_session_id: null,
      consumed_client_family: null
    });

    const redeemed = await redeemConnectionShare({
      connectionShareCode: 'a'.repeat(64),
      targetClientType: 'desktop',
      userAgent: null
    });

    const [stored] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(stored).toMatchObject({
      clientType: 'desktop',
      signatureFormat: 'share'
    });
    expect(claimsOf(redeemed!.response.access_token)).toMatchObject({
      ct: 'desktop',
      sb: 'share',
      sid: stored.id
    });
  });
});
