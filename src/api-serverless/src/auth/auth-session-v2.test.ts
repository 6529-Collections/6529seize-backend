import { authDb } from './auth.db';
import {
  clearWalletSessionCookie,
  createConnectionTransfer,
  createWebSession,
  logoutNativeSession,
  parseWalletSessionCookieHeader,
  redeemConnectionTransfer,
  refreshNativeSession,
  WALLET_SESSION_COOKIE_NAME
} from './auth-session-v2';

jest.mock('./auth.db', () => ({
  authDb: {
    createWalletAuthSession: jest.fn(),
    getActiveNativeSessionByRefreshHash: jest.fn(),
    rotateNativeSessionRefreshToken: jest.fn(),
    revokeWalletAuthSessionsForAddress: jest.fn(),
    revokeWalletAuthSessionByRefreshHash: jest.fn(),
    createWalletConnectionTransfer: jest.fn(),
    consumeWalletConnectionTransfer: jest.fn(),
    markWalletConnectionTransferSession: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(async (fn) =>
      fn({ connection: { id: 'tx' } })
    )
  }
}));

const authDbMock = authDb as jest.Mocked<typeof authDb>;

describe('auth-session-v2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_EXPIRY_SECONDS = '900';
    process.env.AUTH_SESSION_HASH_SECRET = 'test-session-hash-secret';
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRY_SECONDS;
    delete process.env.AUTH_SESSION_HASH_SECRET;
  });

  it('serializes and parses web session cookies without exposing stored raw secrets', async () => {
    authDbMock.createWalletAuthSession.mockImplementation(async (params) => ({
      id: params.id,
      address: params.address,
      role: params.role,
      client_type: params.clientType,
      secret_hash: params.secretHash,
      refresh_token_hash: params.refreshTokenHash,
      user_agent_hash: params.userAgentHash,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const result = await createWebSession({
      address: '0xABCDEF',
      role: 'profile-1',
      userAgent: 'Mozilla/5.0'
    });

    expect(result.response).toMatchObject({
      address: '0xabcdef',
      role: 'profile-1',
      client_type: 'web'
    });
    expect(result.response).not.toHaveProperty('refresh_token');
    expect(result.setCookie).toContain(`${WALLET_SESSION_COOKIE_NAME}=`);
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('Secure');
    expect(result.setCookie).toContain('SameSite=Lax');
    expect(result.setCookie).toContain('Path=/api/auth');

    const cookie = parseWalletSessionCookieHeader(result.setCookie);
    expect(cookie).toEqual({
      sessionId: expect.any(String),
      secret: expect.any(String)
    });

    const [storedSession] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(storedSession.address).toBe('0xabcdef');
    expect(storedSession.clientType).toBe('web');
    expect(storedSession.refreshTokenHash).toBeNull();
    expect(storedSession.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.secretHash).not.toBe(cookie?.secret);
    expect(storedSession.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.userAgentHash).not.toBe('Mozilla/5.0');
  });

  it('clears malformed or missing web session cookies safely', () => {
    expect(parseWalletSessionCookieHeader(undefined)).toBeNull();
    expect(
      parseWalletSessionCookieHeader(`${WALLET_SESSION_COOKIE_NAME}=badvalue`)
    ).toBeNull();
    expect(
      parseWalletSessionCookieHeader(`${WALLET_SESSION_COOKIE_NAME}=%`)
    ).toBeNull();
    expect(clearWalletSessionCookie()).toBe(
      `${WALLET_SESSION_COOKIE_NAME}=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Lax`
    );
  });

  it('requires native refresh-token ownership before revoking all sessions', async () => {
    authDbMock.getActiveNativeSessionByRefreshHash.mockResolvedValueOnce(null);

    await logoutNativeSession({
      address: '0xABC',
      nativeRefreshToken: 'invalid-native-refresh-token',
      allSessions: true
    });

    expect(
      authDbMock.revokeWalletAuthSessionsForAddress
    ).not.toHaveBeenCalled();

    authDbMock.getActiveNativeSessionByRefreshHash.mockResolvedValueOnce({
      id: 'session-1',
      address: '0xabc',
      role: null,
      client_type: 'native',
      secret_hash: null,
      refresh_token_hash: 'refresh-hash',
      user_agent_hash: null,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null
    });

    await logoutNativeSession({
      address: '0xABC',
      nativeRefreshToken: 'valid-native-refresh-token',
      allSessions: true
    });

    expect(authDbMock.getActiveNativeSessionByRefreshHash).toHaveBeenCalledWith(
      '0xabc',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date)
    );
    expect(authDbMock.revokeWalletAuthSessionsForAddress).toHaveBeenCalledWith(
      '0xabc',
      expect.any(Date)
    );
  });

  it('rotates native refresh tokens and only uses server-side token hashes', async () => {
    authDbMock.getActiveNativeSessionByRefreshHash.mockResolvedValue({
      id: 'session-1',
      address: '0xabc',
      role: 'profile-1',
      client_type: 'native',
      secret_hash: null,
      refresh_token_hash: 'old-hash',
      user_agent_hash: null,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null
    });
    authDbMock.rotateNativeSessionRefreshToken.mockImplementation(
      async (params) => ({
        id: params.sessionId,
        address: '0xabc',
        role: 'profile-1',
        client_type: 'native',
        secret_hash: null,
        refresh_token_hash: params.nextRefreshTokenHash,
        user_agent_hash: null,
        created_at: new Date(),
        last_used_at: params.now,
        expires_at: params.expiresAt,
        revoked_at: null
      })
    );

    const result = await refreshNativeSession({
      address: '0xABC',
      nativeRefreshToken: 'raw-native-refresh-token'
    });

    expect(result?.response).toMatchObject({
      address: '0xabc',
      role: 'profile-1',
      client_type: 'native'
    });
    expect(result?.response.native_refresh_token).toEqual(expect.any(String));
    expect(result?.response.native_refresh_token).not.toBe(
      'raw-native-refresh-token'
    );

    const getCall =
      authDbMock.getActiveNativeSessionByRefreshHash.mock.calls[0];
    expect(getCall[0]).toBe('0xabc');
    expect(getCall[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(getCall[1]).not.toBe('raw-native-refresh-token');

    const [rotateParams] =
      authDbMock.rotateNativeSessionRefreshToken.mock.calls[0];
    expect(rotateParams.sessionId).toBe('session-1');
    expect(rotateParams.previousRefreshTokenHash).toBe(getCall[1]);
    expect(rotateParams.nextRefreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rotateParams.nextRefreshTokenHash).not.toBe(
      result?.response.native_refresh_token
    );
  });

  it('creates one-time transfer codes as hashes and redeems them into native sessions', async () => {
    authDbMock.createWalletConnectionTransfer.mockImplementation(
      async (params) => ({
        id: params.id,
        transfer_code_hash: params.transferCodeHash,
        address: params.address,
        role: params.role,
        target_client_type: params.targetClientType,
        created_at: new Date(),
        expires_at: params.expiresAt,
        consumed_at: null,
        consumed_session_id: null
      })
    );
    authDbMock.consumeWalletConnectionTransfer.mockResolvedValue({
      id: 'transfer-1',
      transfer_code_hash: 'hashed-transfer',
      address: '0xabc',
      role: 'profile-1',
      target_client_type: 'native',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: new Date(),
      consumed_session_id: null
    });
    authDbMock.createWalletAuthSession.mockImplementation(async (params) => ({
      id: params.id,
      address: params.address,
      role: params.role,
      client_type: params.clientType,
      secret_hash: params.secretHash,
      refresh_token_hash: params.refreshTokenHash,
      user_agent_hash: params.userAgentHash,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const created = await createConnectionTransfer({
      address: '0xABC',
      role: 'profile-1',
      targetClientType: 'native'
    });

    expect(created).toMatchObject({
      address: '0xabc',
      role: 'profile-1',
      target_client_type: 'native'
    });
    expect(created.transfer_code).toEqual(expect.any(String));
    expect(created.deep_link_path).toContain('transfer_code=');
    expect(created.deep_link_path).not.toContain('token=');

    const [storedTransfer] =
      authDbMock.createWalletConnectionTransfer.mock.calls[0];
    expect(storedTransfer.transferCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedTransfer.transferCodeHash).not.toBe(created.transfer_code);

    const redeemed = await redeemConnectionTransfer({
      transferCode: created.transfer_code,
      targetClientType: 'native',
      userAgent: 'Capacitor'
    });

    expect(redeemed?.response).toMatchObject({
      address: '0xabc',
      role: 'profile-1'
    });
    expect(redeemed?.response.native_refresh_token).toEqual(expect.any(String));
    expect(redeemed?.response).not.toHaveProperty('client_type');

    const [consumeParams] =
      authDbMock.consumeWalletConnectionTransfer.mock.calls[0];
    expect(consumeParams.transferCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(consumeParams.transferCodeHash).not.toBe(created.transfer_code);
    expect(consumeParams.targetClientType).toBe('native');
    expect(authDbMock.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
    expect(authDbMock.markWalletConnectionTransferSession).toHaveBeenCalledWith(
      'transfer-1',
      expect.any(String),
      { connection: { id: 'tx' } }
    );
  });
});
