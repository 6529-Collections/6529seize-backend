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
});
