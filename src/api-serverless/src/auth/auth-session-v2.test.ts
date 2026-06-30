import { authDb } from './auth.db';
import {
  clearWalletSessionCookie,
  clearWalletSessionCookieForAddressAndOrigin,
  clearWalletSessionCookieForOrigin,
  createConnectionShare,
  createNativeSession,
  createWebSession,
  getActiveWebSession,
  getWalletSessionCookieNameForAddress,
  hasActiveWebSessionForAddressAndRole,
  isAuthConnectionSharingEnabled,
  logoutNativeSession,
  logoutWebSession,
  parseWalletSessionCookieHeader,
  parseWalletSessionCookieHeaderForAddress,
  redeemConnectionShare,
  refreshWebSession,
  refreshWebSessionForAddress,
  refreshNativeSession,
  WALLET_SESSION_COOKIE_NAME
} from './auth-session-v2';

jest.mock('./auth.db', () => ({
  authDb: {
    createWalletAuthSession: jest.fn(),
    getActiveNativeSessionByRefreshHash: jest.fn(),
    getActiveWebSessionBySecretHash: jest.fn(),
    rotateNativeSessionRefreshToken: jest.fn(),
    rotateWebSessionSecret: jest.fn(),
    revokeWalletAuthSession: jest.fn(),
    revokeWalletAuthSessionsForAddress: jest.fn(),
    revokeWalletAuthSessionByRefreshHash: jest.fn(),
    createWalletConnectionShare: jest.fn(),
    consumeWalletConnectionShare: jest.fn(),
    markWalletConnectionShareSession: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(async (fn) =>
      fn({ connection: { id: 'tx' } })
    )
  }
}));

const authDbMock = authDb as jest.Mocked<typeof authDb>;

function toCookieRequestHeader(setCookies: readonly string[]): string {
  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

function webSession({
  id,
  address,
  role = null,
  clientOrigin = 'https://6529.io'
}: {
  readonly id: string;
  readonly address: string;
  readonly role?: string | null;
  readonly clientOrigin?: string;
}) {
  return {
    id,
    address,
    role,
    client_type: 'web' as const,
    secret_hash: `${id}-secret-hash`,
    refresh_token_hash: null,
    user_agent_hash: null,
    signature_domain: '6529.io',
    client_origin: clientOrigin,
    created_at: new Date(),
    last_used_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null
  };
}

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
    delete process.env.AUTH_CONNECTION_SHARING_DISABLED;
  });

  it('enables connection sharing unless explicitly disabled', () => {
    delete process.env.AUTH_CONNECTION_SHARING_DISABLED;
    expect(isAuthConnectionSharingEnabled()).toBe(true);

    process.env.AUTH_CONNECTION_SHARING_DISABLED = 'false';
    expect(isAuthConnectionSharingEnabled()).toBe(true);

    process.env.AUTH_CONNECTION_SHARING_DISABLED = 'true';
    expect(isAuthConnectionSharingEnabled()).toBe(false);
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
      signature_domain: params.signatureDomain,
      client_origin: params.clientOrigin,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const result = await createWebSession({
      address: '0xABCDEF',
      role: 'profile-1',
      userAgent: 'Mozilla/5.0',
      signatureDomain: '6529.io',
      clientOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(result.response).toMatchObject({
      address: '0xabcdef',
      role: 'profile-1',
      client_type: 'web'
    });
    expect(result.response).not.toHaveProperty('refresh_token');
    expect(result.setCookie).toHaveLength(2);
    const setCookieHeader = result.setCookie.join('\n');
    const cookieRequestHeader = toCookieRequestHeader(result.setCookie);
    expect(setCookieHeader).toContain(`${WALLET_SESSION_COOKIE_NAME}=`);
    expect(setCookieHeader).toContain(
      `${getWalletSessionCookieNameForAddress('0xABCDEF')}=`
    );
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain('Path=/api/auth');

    const legacyCookieHeader = result.setCookie.find((cookie) =>
      cookie.startsWith(`${WALLET_SESSION_COOKIE_NAME}=`)
    );
    const cookie = parseWalletSessionCookieHeader(legacyCookieHeader);
    expect(cookie).toEqual({
      sessionId: expect.any(String),
      secret: expect.any(String)
    });
    expect(
      parseWalletSessionCookieHeaderForAddress(
        cookieRequestHeader,
        '0xABCDEF'
      )[0]
    ).toEqual(cookie);

    const [storedSession] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(storedSession.address).toBe('0xabcdef');
    expect(storedSession.clientType).toBe('web');
    expect(storedSession.refreshTokenHash).toBeNull();
    expect(storedSession.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.secretHash).not.toBe(cookie?.secret);
    expect(storedSession.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.userAgentHash).not.toBe('Mozilla/5.0');
    expect(storedSession.signatureDomain).toBe('6529.io');
    expect(storedSession.clientOrigin).toBe('https://6529.io');
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
    expect(
      clearWalletSessionCookieForOrigin({
        clientOrigin: 'http://localhost:3001',
        apiHost: 'api.staging.6529.io'
      })
    ).toBe(
      `${WALLET_SESSION_COOKIE_NAME}=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=None`
    );
  });

  it('uses SameSite=None for allowed cross-site localhost web sessions', async () => {
    authDbMock.createWalletAuthSession.mockImplementation(async (params) => ({
      id: params.id,
      address: params.address,
      role: params.role,
      client_type: params.clientType,
      secret_hash: params.secretHash,
      refresh_token_hash: params.refreshTokenHash,
      user_agent_hash: params.userAgentHash,
      signature_domain: params.signatureDomain,
      client_origin: params.clientOrigin,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const result = await createWebSession({
      address: '0xABCDEF',
      role: null,
      userAgent: 'Mozilla/5.0',
      signatureDomain: 'localhost:3001',
      clientOrigin: 'http://localhost:3001',
      apiHost: 'api.staging.6529.io'
    });

    const setCookieHeader = result.setCookie.join('\n');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=None');
    expect(setCookieHeader).not.toContain('SameSite=Lax');
  });

  it('keeps SameSite=Lax for staging web sessions that are same-site with the staging API', async () => {
    authDbMock.createWalletAuthSession.mockImplementation(async (params) => ({
      id: params.id,
      address: params.address,
      role: params.role,
      client_type: params.clientType,
      secret_hash: params.secretHash,
      refresh_token_hash: params.refreshTokenHash,
      user_agent_hash: params.userAgentHash,
      signature_domain: params.signatureDomain,
      client_origin: params.clientOrigin,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const result = await createWebSession({
      address: '0xABCDEF',
      role: null,
      userAgent: 'Mozilla/5.0',
      signatureDomain: 'staging.6529.io',
      clientOrigin: 'https://staging.6529.io',
      apiHost: 'api.staging.6529.io'
    });

    const setCookieHeader = result.setCookie.join('\n');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).not.toContain('SameSite=None');
  });

  it('creates desktop refresh-token sessions with a desktop client type', async () => {
    authDbMock.createWalletAuthSession.mockImplementation(async (params) => ({
      id: params.id,
      address: params.address,
      role: params.role,
      client_type: params.clientType,
      secret_hash: params.secretHash,
      refresh_token_hash: params.refreshTokenHash,
      user_agent_hash: params.userAgentHash,
      signature_domain: params.signatureDomain,
      client_origin: params.clientOrigin,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const result = await createNativeSession({
      address: '0xABCDEF',
      role: 'profile-1',
      userAgent: '6529 Desktop',
      clientType: 'desktop'
    });

    expect(result.response).toMatchObject({
      address: '0xabcdef',
      role: 'profile-1',
      client_type: 'desktop'
    });
    expect(result.response.native_refresh_token).toEqual(expect.any(String));

    const [storedSession] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(storedSession.clientType).toBe('desktop');
    expect(storedSession.secretHash).toBeNull();
    expect(storedSession.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.signatureDomain).toBeNull();
    expect(storedSession.clientOrigin).toBeNull();
  });

  it('loads active web sessions from the session-v2 cookie without trusting URL role metadata', async () => {
    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValue({
      id: 'session-1',
      address: '0xABC',
      role: 'profile-1',
      client_type: 'web',
      secret_hash: 'stored-secret-hash',
      refresh_token_hash: null,
      user_agent_hash: null,
      signature_domain: '6529.io',
      client_origin: 'https://6529.io',
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null
    });

    const session = await getActiveWebSession({
      cookie: { sessionId: 'session-1', secret: 'cookie-secret' },
      requestOrigin: 'https://6529.io'
    });

    expect(session).toEqual({
      address: '0xabc',
      role: 'profile-1'
    });
    const [sessionId, secretHash] =
      authDbMock.getActiveWebSessionBySecretHash.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secretHash).not.toBe('cookie-secret');
  });

  it('finds the address-scoped web session cookie when another account owns the compatibility cookie', async () => {
    const addressScopedCookieName =
      getWalletSessionCookieNameForAddress('0xAAA');
    const cookieHeader = [
      `${addressScopedCookieName}=${encodeURIComponent('session-a.secret-a')}`,
      `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent('session-b.secret-b')}`
    ].join('; ');

    authDbMock.getActiveWebSessionBySecretHash.mockImplementation(
      async (sessionId) => {
        if (sessionId === 'session-a') {
          return {
            id: 'session-a',
            address: '0xAAA',
            role: 'profile-a',
            client_type: 'web',
            secret_hash: 'stored-secret-hash-a',
            refresh_token_hash: null,
            user_agent_hash: null,
            signature_domain: '6529.io',
            client_origin: 'https://6529.io',
            created_at: new Date(),
            last_used_at: new Date(),
            expires_at: new Date(Date.now() + 60_000),
            revoked_at: null
          };
        }
        if (sessionId === 'session-b') {
          return {
            id: 'session-b',
            address: '0xBBB',
            role: 'profile-b',
            client_type: 'web',
            secret_hash: 'stored-secret-hash-b',
            refresh_token_hash: null,
            user_agent_hash: null,
            signature_domain: '6529.io',
            client_origin: 'https://6529.io',
            created_at: new Date(),
            last_used_at: new Date(),
            expires_at: new Date(Date.now() + 60_000),
            revoked_at: null
          };
        }
        return null;
      }
    );

    await expect(
      hasActiveWebSessionForAddressAndRole({
        cookieHeader,
        address: '0xaaa',
        role: 'profile-a',
        requestOrigin: 'https://6529.io'
      })
    ).resolves.toBe(true);

    expect(authDbMock.getActiveWebSessionBySecretHash).toHaveBeenCalledTimes(1);
    expect(authDbMock.getActiveWebSessionBySecretHash).toHaveBeenCalledWith(
      'session-a',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date)
    );
  });

  it('rejects address-scoped web session cookies with the wrong role', async () => {
    const addressScopedCookieName =
      getWalletSessionCookieNameForAddress('0xAAA');
    const cookieHeader = `${addressScopedCookieName}=${encodeURIComponent(
      'session-a.secret-a'
    )}`;

    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValue({
      id: 'session-a',
      address: '0xAAA',
      role: 'profile-a',
      client_type: 'web',
      secret_hash: 'stored-secret-hash-a',
      refresh_token_hash: null,
      user_agent_hash: null,
      signature_domain: '6529.io',
      client_origin: 'https://6529.io',
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null
    });

    await expect(
      hasActiveWebSessionForAddressAndRole({
        cookieHeader,
        address: '0xaaa',
        role: 'profile-b',
        requestOrigin: 'https://6529.io'
      })
    ).resolves.toBe(false);
  });

  it('refreshes the address-scoped web session when the compatibility cookie belongs to another account', async () => {
    const addressScopedCookieName =
      getWalletSessionCookieNameForAddress('0xAAA');
    const cookieHeader = [
      `${addressScopedCookieName}=${encodeURIComponent('session-a.secret-a')}`,
      `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent('session-b.secret-b')}`
    ].join('; ');

    authDbMock.getActiveWebSessionBySecretHash.mockImplementation(
      async (sessionId) => {
        if (sessionId === 'session-a') {
          return webSession({
            id: 'session-a',
            address: '0xaaa',
            role: 'profile-a'
          });
        }
        return webSession({
          id: 'session-b',
          address: '0xbbb',
          role: 'profile-b'
        });
      }
    );
    authDbMock.rotateWebSessionSecret.mockImplementation(async (params) =>
      webSession({
        id: params.sessionId,
        address: '0xaaa',
        role: 'profile-a'
      })
    );

    const refreshed = await refreshWebSessionForAddress({
      cookieHeader,
      address: '0xaaa',
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(refreshed?.response).toMatchObject({
      address: '0xaaa',
      role: 'profile-a',
      client_type: 'web'
    });
    expect(authDbMock.rotateWebSessionSecret).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-a' })
    );
    expect(authDbMock.rotateWebSessionSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-b' })
    );
  });

  it('does not refresh another account from the compatibility cookie when the requested scoped session is missing', async () => {
    const cookieHeader = `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent(
      'session-b.secret-b'
    )}`;
    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValue(
      webSession({
        id: 'session-b',
        address: '0xbbb',
        role: 'profile-b'
      })
    );

    await expect(
      refreshWebSessionForAddress({
        cookieHeader,
        address: '0xaaa',
        requestOrigin: 'https://6529.io',
        apiHost: 'api.6529.io'
      })
    ).resolves.toBeNull();

    expect(authDbMock.rotateWebSessionSecret).not.toHaveBeenCalled();
  });

  it('logs out the requested address-scoped web session without revoking another account', async () => {
    const addressScopedCookieName =
      getWalletSessionCookieNameForAddress('0xAAA');
    const cookieHeader = [
      `${addressScopedCookieName}=${encodeURIComponent('session-a.secret-a')}`,
      `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent('session-b.secret-b')}`
    ].join('; ');
    authDbMock.getActiveWebSessionBySecretHash.mockImplementation(
      async (sessionId) =>
        sessionId === 'session-a'
          ? webSession({ id: 'session-a', address: '0xaaa' })
          : webSession({ id: 'session-b', address: '0xbbb' })
    );

    const clearedCookies = await logoutWebSession({
      cookieHeader,
      address: '0xaaa',
      allSessions: false,
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(authDbMock.revokeWalletAuthSession).toHaveBeenCalledWith(
      'session-a',
      expect.any(Date)
    );
    expect(authDbMock.revokeWalletAuthSession).not.toHaveBeenCalledWith(
      'session-b',
      expect.any(Date)
    );
    expect(clearedCookies).toEqual(
      clearWalletSessionCookieForAddressAndOrigin({
        address: '0xaaa',
        clientOrigin: 'https://6529.io',
        apiHost: 'api.6529.io',
        includeCompatibilityCookie: false
      })
    );
  });

  it('revokes all sessions only for the requested web address', async () => {
    const addressScopedCookieName =
      getWalletSessionCookieNameForAddress('0xAAA');
    const cookieHeader = [
      `${addressScopedCookieName}=${encodeURIComponent('session-a.secret-a')}`,
      `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent('session-b.secret-b')}`
    ].join('; ');
    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValue(
      webSession({ id: 'session-a', address: '0xaaa' })
    );

    await logoutWebSession({
      cookieHeader,
      address: '0xaaa',
      allSessions: true,
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(authDbMock.revokeWalletAuthSessionsForAddress).toHaveBeenCalledWith(
      '0xaaa',
      expect.any(Date)
    );
    expect(
      authDbMock.revokeWalletAuthSessionsForAddress
    ).not.toHaveBeenCalledWith('0xbbb', expect.any(Date));
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
      signature_domain: null,
      client_origin: null,
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
      expect.any(Date),
      'native'
    );
    expect(authDbMock.revokeWalletAuthSessionsForAddress).toHaveBeenCalledWith(
      '0xabc',
      expect.any(Date)
    );
  });

  it('requires web session cookie secret ownership before revoking a session', async () => {
    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValueOnce(null);

    const clearedCookie = await logoutWebSession({
      cookieHeader: `${WALLET_SESSION_COOKIE_NAME}=session-1.wrong-secret`,
      address: null,
      allSessions: false,
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(authDbMock.getActiveWebSessionBySecretHash).toHaveBeenCalledWith(
      'session-1',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date)
    );
    expect(authDbMock.revokeWalletAuthSession).not.toHaveBeenCalled();
    expect(clearedCookie).toBe(clearWalletSessionCookie());

    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValueOnce({
      id: 'session-1',
      address: '0xabc',
      role: null,
      client_type: 'web',
      secret_hash: 'secret-hash',
      refresh_token_hash: null,
      user_agent_hash: null,
      signature_domain: '6529.io',
      client_origin: 'https://6529.io',
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null
    });

    await logoutWebSession({
      cookieHeader: `${WALLET_SESSION_COOKIE_NAME}=session-1.valid-secret`,
      address: null,
      allSessions: false,
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(authDbMock.revokeWalletAuthSession).toHaveBeenCalledWith(
      'session-1',
      expect.any(Date)
    );
  });

  it('requires matching web session origin before refreshing', async () => {
    authDbMock.getActiveWebSessionBySecretHash.mockResolvedValue({
      id: 'session-1',
      address: '0xabc',
      role: 'profile-1',
      client_type: 'web',
      secret_hash: 'secret-hash',
      refresh_token_hash: null,
      user_agent_hash: null,
      signature_domain: '6529.io',
      client_origin: 'https://6529.io',
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null
    });

    await expect(
      refreshWebSession({
        cookie: {
          sessionId: 'session-1',
          secret: 'valid-secret'
        },
        requestOrigin: 'https://evil.example',
        apiHost: 'api.6529.io'
      })
    ).resolves.toBeNull();
    expect(authDbMock.rotateWebSessionSecret).not.toHaveBeenCalled();

    authDbMock.rotateWebSessionSecret.mockImplementation(async (params) => ({
      id: params.sessionId,
      address: '0xabc',
      role: 'profile-1',
      client_type: 'web',
      secret_hash: params.nextSecretHash,
      refresh_token_hash: null,
      user_agent_hash: null,
      signature_domain: '6529.io',
      client_origin: 'https://6529.io',
      created_at: new Date(),
      last_used_at: params.now,
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const refreshed = await refreshWebSession({
      cookie: {
        sessionId: 'session-1',
        secret: 'valid-secret'
      },
      requestOrigin: 'https://6529.io',
      apiHost: 'api.6529.io'
    });

    expect(refreshed?.response).toMatchObject({
      address: '0xabc',
      role: 'profile-1',
      client_type: 'web'
    });
    expect(refreshed?.setCookie).toHaveLength(2);
    expect(refreshed?.setCookie.join('\n')).toContain(
      `${getWalletSessionCookieNameForAddress('0xabc')}=`
    );
    expect(authDbMock.rotateWebSessionSecret).toHaveBeenCalledTimes(1);
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
      signature_domain: null,
      client_origin: null,
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
        signature_domain: null,
        client_origin: null,
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
    expect(rotateParams.clientType).toBe('native');
  });

  it('rotates desktop refresh tokens separately from native sessions', async () => {
    authDbMock.getActiveNativeSessionByRefreshHash.mockResolvedValue({
      id: 'session-1',
      address: '0xabc',
      role: 'profile-1',
      client_type: 'desktop',
      secret_hash: null,
      refresh_token_hash: 'old-hash',
      user_agent_hash: null,
      signature_domain: null,
      client_origin: null,
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
        client_type: 'desktop',
        secret_hash: null,
        refresh_token_hash: params.nextRefreshTokenHash,
        user_agent_hash: null,
        signature_domain: null,
        client_origin: null,
        created_at: new Date(),
        last_used_at: params.now,
        expires_at: params.expiresAt,
        revoked_at: null
      })
    );

    const result = await refreshNativeSession({
      address: '0xABC',
      nativeRefreshToken: 'raw-desktop-refresh-token',
      clientType: 'desktop'
    });

    expect(result?.response).toMatchObject({
      address: '0xabc',
      role: 'profile-1',
      client_type: 'desktop'
    });
    expect(authDbMock.getActiveNativeSessionByRefreshHash).toHaveBeenCalledWith(
      '0xabc',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date),
      'desktop'
    );
    const [rotateParams] =
      authDbMock.rotateNativeSessionRefreshToken.mock.calls[0];
    expect(rotateParams.clientType).toBe('desktop');
  });

  it('creates one-time connection share codes as hashes and redeems them into native sessions', async () => {
    authDbMock.createWalletConnectionShare.mockImplementation(
      async (params) => ({
        id: params.id,
        connection_share_code_hash: params.connectionShareCodeHash,
        address: params.address,
        role: params.role,
        target_client_type: params.targetClientType,
        created_at: new Date(),
        expires_at: params.expiresAt,
        consumed_at: null,
        consumed_session_id: null
      })
    );
    authDbMock.consumeWalletConnectionShare.mockResolvedValue({
      id: 'share-1',
      connection_share_code_hash: 'hashed-share',
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
      signature_domain: params.signatureDomain,
      client_origin: params.clientOrigin,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const created = await createConnectionShare({
      address: '0xABC',
      role: 'profile-1',
      targetClientType: 'native'
    });

    expect(created).toMatchObject({
      address: '0xabc',
      role: 'profile-1',
      target_client_type: 'native'
    });
    expect(created.connection_share_code).toEqual(expect.any(String));
    expect(created.deep_link_path).toContain('connection_share_code=');
    expect(created.deep_link_path).toContain('address=0xabc');
    expect(created.deep_link_path).not.toContain('token=');
    expect(created.deep_link_path).not.toContain('role=');

    const [storedShare] = authDbMock.createWalletConnectionShare.mock.calls[0];
    expect(storedShare.connectionShareCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedShare.connectionShareCodeHash).not.toBe(
      created.connection_share_code
    );

    const redeemed = await redeemConnectionShare({
      connectionShareCode: created.connection_share_code,
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
      authDbMock.consumeWalletConnectionShare.mock.calls[0];
    expect(consumeParams.connectionShareCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(consumeParams.connectionShareCodeHash).not.toBe(
      created.connection_share_code
    );
    expect(consumeParams.targetClientType).toBe('native');
    expect(authDbMock.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
    expect(authDbMock.markWalletConnectionShareSession).toHaveBeenCalledWith(
      'share-1',
      expect.any(String),
      { connection: { id: 'tx' } }
    );
  });

  it('creates one-time connection share codes for desktop sessions', async () => {
    authDbMock.createWalletConnectionShare.mockImplementation(
      async (params) => ({
        id: params.id,
        connection_share_code_hash: params.connectionShareCodeHash,
        address: params.address,
        role: params.role,
        target_client_type: params.targetClientType,
        created_at: new Date(),
        expires_at: params.expiresAt,
        consumed_at: null,
        consumed_session_id: null
      })
    );
    authDbMock.consumeWalletConnectionShare.mockResolvedValue({
      id: 'share-1',
      connection_share_code_hash: 'hashed-share',
      address: '0xabc',
      role: 'profile-1',
      target_client_type: 'desktop',
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
      signature_domain: params.signatureDomain,
      client_origin: params.clientOrigin,
      created_at: new Date(),
      last_used_at: new Date(),
      expires_at: params.expiresAt,
      revoked_at: null
    }));

    const created = await createConnectionShare({
      address: '0xABC',
      role: 'profile-1',
      targetClientType: 'desktop'
    });
    const redeemed = await redeemConnectionShare({
      connectionShareCode: created.connection_share_code,
      targetClientType: 'desktop',
      userAgent: '6529 Desktop'
    });

    expect(created).toMatchObject({
      address: '0xabc',
      role: 'profile-1',
      target_client_type: 'desktop'
    });
    expect(redeemed?.response.native_refresh_token).toEqual(expect.any(String));

    const [storedSession] = authDbMock.createWalletAuthSession.mock.calls[0];
    expect(storedSession.clientType).toBe('desktop');
    const [consumeParams] =
      authDbMock.consumeWalletConnectionShare.mock.calls[0];
    expect(consumeParams.targetClientType).toBe('desktop');
  });

  it('rejects web connection-share targets at the service boundary', async () => {
    await expect(
      createConnectionShare({
        address: '0xABC',
        role: null,
        targetClientType: 'web'
      })
    ).rejects.toThrow('refresh-token clients only');

    await expect(
      redeemConnectionShare({
        connectionShareCode: 'a'.repeat(64),
        targetClientType: 'web',
        userAgent: 'Mozilla/5.0'
      })
    ).rejects.toThrow('refresh-token clients only');
  });
});
