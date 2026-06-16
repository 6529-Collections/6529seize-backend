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
