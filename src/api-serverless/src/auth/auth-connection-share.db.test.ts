import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { AuthDb } from './auth.db';

describeWithSeed('Encrypted connection-share consumption', [], () => {
  it('returns stored ciphertext to exactly one concurrent consumer and never on replay', async () => {
    const repo = new AuthDb(() => sqlExecutor);
    const now = new Date();
    await repo.createWalletConnectionShare({
      id: 'encrypted-share',
      connectionShareCodeHash: 'a'.repeat(64),
      encryptedDeviceSetup: 'v1.private-ciphertext',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      role: null,
      targetClientType: 'native',
      expiresAt: new Date(now.getTime() + 60_000)
    });
    const params = {
      connectionShareCodeHash: 'a'.repeat(64),
      targetClientType: 'native' as const,
      now
    };
    await expect(
      repo.consumeWalletConnectionShare({
        ...params,
        targetClientType: 'desktop'
      })
    ).resolves.toBeNull();

    const consume = () =>
      repo.executeNativeQueriesInTransaction((connection) =>
        repo.consumeWalletConnectionShare(params, connection)
      );
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)).toMatchObject({
      encrypted_device_setup: 'v1.private-ciphertext',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_client_type: 'native'
    });
    await expect(consume()).resolves.toBeNull();
  });

  it('retires only the live share of the same wallet, target and kind', async () => {
    const repo = new AuthDb(() => sqlExecutor);
    const now = new Date();
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const share = (
      id: string,
      overrides: Partial<{
        address: string;
        targetClientType: 'native' | 'desktop';
        encryptedDeviceSetup: string | null;
        expiresAt: Date;
      }> = {}
    ) =>
      repo.createWalletConnectionShare({
        id,
        connectionShareCodeHash: `${id}${'0'.repeat(64)}`.slice(0, 64),
        encryptedDeviceSetup: null,
        address: wallet,
        role: null,
        targetClientType: 'native',
        expiresAt: new Date(now.getTime() + 60_000),
        ...overrides
      });
    await share('plain-native');
    await share('setup-native', { encryptedDeviceSetup: 'v1.ciphertext' });
    await share('plain-desktop', { targetClientType: 'desktop' });
    await share('plain-other', {
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    });

    await expect(
      repo.retireLiveWalletConnectionShares({
        address: wallet,
        targetClientType: 'native',
        withDeviceSetup: false,
        now
      })
    ).resolves.toBe(1);

    const consume = (id: string, targetClientType: 'native' | 'desktop') =>
      repo.consumeWalletConnectionShare({
        connectionShareCodeHash: `${id}${'0'.repeat(64)}`.slice(0, 64),
        targetClientType,
        now,
        clientFamily: 'browser'
      });
    await expect(consume('plain-native', 'native')).resolves.toBeNull();
    await expect(consume('setup-native', 'native')).resolves.toMatchObject({
      id: 'setup-native',
      consumed_client_family: 'browser'
    });
    await expect(consume('plain-desktop', 'desktop')).resolves.toMatchObject({
      id: 'plain-desktop'
    });
    await expect(consume('plain-other', 'native')).resolves.toMatchObject({
      id: 'plain-other'
    });
  });

  it('keeps the previous share live when the replacing share cannot be stored', async () => {
    const repo = new AuthDb(() => sqlExecutor);
    const now = new Date();
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shareParams = (id: string, codeHash: string) => ({
      id,
      connectionShareCodeHash: codeHash,
      encryptedDeviceSetup: null,
      address: wallet,
      role: null,
      targetClientType: 'native' as const,
      expiresAt: new Date(now.getTime() + 60_000)
    });
    await repo.createWalletConnectionShare(
      shareParams('previous-share', 'b'.repeat(64))
    );

    // Same id as the live share: the insert fails after the retire ran.
    await expect(
      repo.executeNativeQueriesInTransaction(async (connection) => {
        await repo.retireLiveWalletConnectionShares(
          {
            address: wallet,
            targetClientType: 'native',
            withDeviceSetup: false,
            now
          },
          connection
        );
        return repo.createWalletConnectionShare(
          shareParams('previous-share', 'c'.repeat(64)),
          connection
        );
      })
    ).rejects.toThrow();

    await expect(
      repo.consumeWalletConnectionShare({
        connectionShareCodeHash: 'b'.repeat(64),
        targetClientType: 'native',
        now
      })
    ).resolves.toMatchObject({ id: 'previous-share' });
  });
});
