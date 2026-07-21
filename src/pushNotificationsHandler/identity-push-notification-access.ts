import { In, type DataSource } from 'typeorm';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { getDataSource } from '@/db';
import { DropEntity } from '@/entities/IDrop';
import { IdentityNotificationEntity } from '@/entities/IIdentityNotification';

export class IdentityPushNotificationAccess {
  constructor(
    private readonly groupsService: UserGroupsService,
    private readonly wavesDb: WavesApiDb,
    private readonly dataSourceSupplier: () => DataSource
  ) {}

  async canRecipientReadRelatedContent(
    notification: IdentityNotificationEntity
  ): Promise<boolean> {
    const waveId = notification.wave_id;
    if (!waveId) {
      return true;
    }

    const eligibleGroupIds =
      await this.groupsService.getGroupsUserIsEligibleFor(
        notification.identity_id
      );
    const visibleWaves = await this.wavesDb.findWavesByIds(
      [waveId],
      eligibleGroupIds
    );
    if (!visibleWaves.some((wave) => wave.id === waveId)) {
      return false;
    }

    const relatedDropIds = Array.from(
      new Set(
        [notification.related_drop_id, notification.related_drop_2_id].filter(
          (dropId): dropId is string => dropId !== null
        )
      )
    );
    if (!relatedDropIds.length) {
      return true;
    }

    const relatedDrops = await this.dataSourceSupplier()
      .getRepository(DropEntity)
      .findBy({ id: In(relatedDropIds) });
    return (
      relatedDrops.length === relatedDropIds.length &&
      relatedDrops.every((drop) => drop.wave_id === waveId)
    );
  }
}

export const identityPushNotificationAccess =
  new IdentityPushNotificationAccess(
    userGroupsService,
    wavesApiDb,
    getDataSource
  );
