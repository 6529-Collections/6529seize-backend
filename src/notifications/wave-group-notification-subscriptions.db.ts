import {
  DropGroupMention,
  WaveGroupNotificationSubscriptionEntity
} from '@/entities/IWaveGroupNotificationSubscription';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE } from '@/constants';

export class WaveGroupNotificationSubscriptionsDb extends LazyDbAccessCompatibleService {
  async getEnabledGroups(
    identityId: string,
    waveId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<DropGroupMention[]> {
    return this.db
      .execute<{ mentioned_group: DropGroupMention }>(
        `select mentioned_group from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
         where identity_id = :identityId and wave_id = :waveId
         order by mentioned_group asc`,
        { identityId, waveId },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((rows) => rows.map((row) => row.mentioned_group));
  }

  async replaceEnabledGroups(
    {
      identityId,
      waveId,
      mentionedGroups
    }: {
      identityId: string;
      waveId: string;
      mentionedGroups: DropGroupMention[];
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.deleteForWave(identityId, waveId, connection);
    await this.insertMany(
      identityId,
      waveId,
      mentionedGroups,
      connection,
      false
    );
  }

  async addDefaultGroupsForWaveSubscription(
    identityId: string,
    waveId: string,
    connection: ConnectionWrapper<any>
  ) {
    await this.insertMany(
      identityId,
      waveId,
      [DropGroupMention.ALL],
      connection
    );
  }

  async deleteForWave(
    identityId: string,
    waveId: string,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
       where identity_id = :identityId and wave_id = :waveId`,
      { identityId, waveId },
      { wrappedConnection: connection }
    );
  }

  async deleteByWaveId(waveId: string, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `delete from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
       where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: connection }
    );
  }

  async updateIdentityIdsInWaveGroupNotificationSubscriptions(
    sourceIdentity: string,
    targetIdentity: string,
    connection: ConnectionWrapper<any>
  ) {
    if (sourceIdentity === targetIdentity) {
      return;
    }

    await this.db.execute(
      `
      delete from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
      where identity_id = :targetIdentity
        and (wave_id, mentioned_group) in (
          select wave_id, mentioned_group from (
            select wave_id, mentioned_group
            from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
            where identity_id = :sourceIdentity
          ) source_rows
        )
      `,
      { sourceIdentity, targetIdentity },
      { wrappedConnection: connection }
    );

    await this.db.execute(
      `
      update ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
      set identity_id = :targetIdentity
      where identity_id = :sourceIdentity
      `,
      { sourceIdentity, targetIdentity },
      { wrappedConnection: connection }
    );
  }

  private async insertMany(
    identityId: string,
    waveId: string,
    mentionedGroups: DropGroupMention[],
    connection: ConnectionWrapper<any>,
    ignoreDuplicates = true
  ) {
    const distinctGroups = Array.from(new Set(mentionedGroups));
    if (!distinctGroups.length) {
      return;
    }
    await this.db.bulkInsert(
      WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
      distinctGroups.map<WaveGroupNotificationSubscriptionEntity>(
        (mentionedGroup) => ({
          identity_id: identityId,
          wave_id: waveId,
          mentioned_group: mentionedGroup
        })
      ),
      ['identity_id', 'wave_id', 'mentioned_group'],
      undefined,
      {
        connection,
        ignoreDuplicates
      }
    );
  }
}

export const waveGroupNotificationSubscriptionsDb =
  new WaveGroupNotificationSubscriptionsDb(dbSupplier);
