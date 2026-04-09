import 'reflect-metadata';
import { WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE } from '@/constants';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { WaveGroupNotificationSubscriptionsDb } from './wave-group-notification-subscriptions.db';

describeWithSeed('WaveGroupNotificationSubscriptionsDb', [] as never[], () => {
  const repo = new WaveGroupNotificationSubscriptionsDb(() => sqlExecutor);

  it('stores the default ALL group only once', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.addDefaultGroupsForWaveSubscription(
        'profile-1',
        'wave-1',
        connection
      );
      await repo.addDefaultGroupsForWaveSubscription(
        'profile-1',
        'wave-1',
        connection
      );
    });

    await expect(repo.getEnabledGroups('profile-1', 'wave-1')).resolves.toEqual(
      [DropGroupMention.ALL]
    );
  });

  it('replaces enabled groups for a wave', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.addDefaultGroupsForWaveSubscription(
        'profile-1',
        'wave-1',
        connection
      );
      await repo.replaceEnabledGroups(
        {
          identityId: 'profile-1',
          waveId: 'wave-1',
          mentionedGroups: []
        },
        connection
      );
    });

    await expect(repo.getEnabledGroups('profile-1', 'wave-1')).resolves.toEqual(
      []
    );
  });

  it('merges source identity rows into target identity without duplicates', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.addDefaultGroupsForWaveSubscription(
        'source-profile',
        'wave-1',
        connection
      );
      await repo.addDefaultGroupsForWaveSubscription(
        'target-profile',
        'wave-1',
        connection
      );
      await repo.updateIdentityIdsInWaveGroupNotificationSubscriptions(
        'source-profile',
        'target-profile',
        connection
      );
    });

    await expect(
      repo.getEnabledGroups('target-profile', 'wave-1')
    ).resolves.toEqual([DropGroupMention.ALL]);

    const remainingSourceRows = await sqlExecutor.execute<{
      identity_id: string;
    }>(
      `select identity_id from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
         where identity_id = :identityId`,
      { identityId: 'source-profile' }
    );
    expect(remainingSourceRows).toEqual([]);
  });

  it('does nothing when source and target identities are the same', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.addDefaultGroupsForWaveSubscription(
        'same-profile',
        'wave-1',
        connection
      );
      await repo.updateIdentityIdsInWaveGroupNotificationSubscriptions(
        'same-profile',
        'same-profile',
        connection
      );
    });

    await expect(
      repo.getEnabledGroups('same-profile', 'wave-1')
    ).resolves.toEqual([DropGroupMention.ALL]);
  });
});
