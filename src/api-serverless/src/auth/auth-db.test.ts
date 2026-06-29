import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import { AuthDb } from './auth.db';

function createExecutor() {
  const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
  const oneOrNull = jest.fn();
  const executor = {
    execute,
    oneOrNull,
    executeNativeQueriesInTransaction: jest.fn(),
    getAffectedRows: jest.fn((result) => result?.affectedRows ?? 0)
  } as unknown as jest.Mocked<SqlExecutor>;
  const authDb = new AuthDb(() => executor);
  return { authDb, execute, oneOrNull };
}

describe('AuthDb', () => {
  it('stores the validated role when creating a legacy refresh token', async () => {
    const { authDb, execute, oneOrNull } = createExecutor();
    oneOrNull.mockResolvedValueOnce(null);

    await authDb.retrieveOrGenerateRefreshToken('0xabc', 'profile-1');

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('(address, refresh_token, role)'),
      expect.objectContaining({
        address: '0xabc',
        role: 'profile-1',
        refreshToken: expect.any(String)
      })
    );
  });

  it('rebinds an existing legacy refresh token after a signed legacy login', async () => {
    const { authDb, execute, oneOrNull } = createExecutor();
    oneOrNull.mockResolvedValueOnce({
      address: '0xabc',
      refresh_token: 'refresh-token',
      role: 'profile-1'
    });

    await expect(
      authDb.retrieveOrGenerateRefreshToken('0xabc', 'profile-2')
    ).resolves.toBe('refresh-token');

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('set role = :role'),
      {
        address: '0xabc',
        refreshToken: 'refresh-token',
        role: 'profile-2'
      }
    );
  });

  it('returns the server-bound legacy refresh role when redeeming a token', async () => {
    const { authDb, oneOrNull } = createExecutor();
    oneOrNull.mockResolvedValueOnce({
      address: '0xABC',
      refresh_token: 'refresh-token',
      role: 'profile-1'
    });

    await expect(
      authDb.redeemRefreshToken('0xabc', 'refresh-token')
    ).resolves.toEqual({
      address: '0xabc',
      role: 'profile-1'
    });
  });

  it('binds only unbound legacy refresh tokens during the migration bridge', async () => {
    const { authDb, execute } = createExecutor();

    await expect(
      authDb.bindUnboundRefreshTokenRole('0xabc', 'refresh-token', 'profile-1')
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('and role is null'),
      {
        address: '0xabc',
        refreshToken: 'refresh-token',
        role: 'profile-1'
      }
    );
  });

  it('reads newly written wallet auth sessions from the write pool', async () => {
    const { authDb, oneOrNull } = createExecutor();
    const session = {
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
      expires_at: new Date(),
      revoked_at: null
    };
    oneOrNull.mockResolvedValueOnce(session);

    await authDb.createWalletAuthSession({
      id: 'session-1',
      address: '0xabc',
      role: null,
      clientType: 'web',
      secretHash: 'secret-hash',
      refreshTokenHash: null,
      userAgentHash: null,
      signatureDomain: '6529.io',
      clientOrigin: 'https://6529.io',
      expiresAt: new Date()
    });

    expect(oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('wallet_auth_sessions'),
      { id: 'session-1' },
      { forcePool: DbPoolName.WRITE }
    );
  });

  it('keeps transaction-wrapped wallet auth session read-backs on the transaction connection', async () => {
    const { authDb, oneOrNull } = createExecutor();
    const connection = { connection: { id: 'tx' } };
    oneOrNull.mockResolvedValueOnce({
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
      expires_at: new Date(),
      revoked_at: null
    });

    await authDb.createWalletAuthSession(
      {
        id: 'session-1',
        address: '0xabc',
        role: null,
        clientType: 'native',
        secretHash: null,
        refreshTokenHash: 'refresh-hash',
        userAgentHash: null,
        signatureDomain: null,
        clientOrigin: null,
        expiresAt: new Date()
      },
      connection
    );

    expect(oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('wallet_auth_sessions'),
      { id: 'session-1' },
      { wrappedConnection: connection }
    );
  });

  it('filters refresh-token wallet auth sessions by the requested client type', async () => {
    const { authDb, execute, oneOrNull } = createExecutor();
    const now = new Date();
    oneOrNull.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'session-1',
      address: '0xabc',
      role: null,
      client_type: 'desktop',
      secret_hash: null,
      refresh_token_hash: 'new-hash',
      user_agent_hash: null,
      signature_domain: null,
      client_origin: null,
      created_at: new Date(),
      last_used_at: now,
      expires_at: now,
      revoked_at: null
    });

    await authDb.getActiveNativeSessionByRefreshHash(
      '0xabc',
      'refresh-hash',
      now,
      'desktop'
    );

    expect(oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('client_type = :clientType'),
      {
        address: '0xabc',
        refreshTokenHash: 'refresh-hash',
        now,
        clientType: 'desktop'
      }
    );

    await authDb.rotateNativeSessionRefreshToken({
      sessionId: 'session-1',
      previousRefreshTokenHash: 'old-hash',
      nextRefreshTokenHash: 'new-hash',
      expiresAt: now,
      now,
      clientType: 'desktop'
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('client_type = :clientType'),
      expect.objectContaining({
        sessionId: 'session-1',
        clientType: 'desktop'
      })
    );
  });

  it('reads newly written connection shares from the write pool', async () => {
    const { authDb, oneOrNull } = createExecutor();
    oneOrNull.mockResolvedValueOnce({
      id: 'share-1',
      connection_share_code_hash: 'share-hash',
      address: '0xabc',
      role: null,
      target_client_type: 'native',
      created_at: new Date(),
      expires_at: new Date(),
      consumed_at: null,
      consumed_session_id: null
    });

    await authDb.createWalletConnectionShare({
      id: 'share-1',
      connectionShareCodeHash: 'share-hash',
      address: '0xabc',
      role: null,
      targetClientType: 'native',
      expiresAt: new Date()
    });

    expect(oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('wallet_connection_shares'),
      { id: 'share-1' },
      { forcePool: DbPoolName.WRITE }
    );
  });
});
