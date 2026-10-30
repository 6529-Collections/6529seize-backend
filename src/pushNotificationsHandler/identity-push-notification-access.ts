import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { artistArtworkSubmissionDb } from '@/notifications/artist-artwork-submission.db';
import { ArtistArtworkNotificationData } from '@/notifications/user-notification.types';
import { In, type DataSource } from 'typeorm';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { getDataSource } from '@/db';
import { DropEntity } from '@/entities/IDrop';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '@/entities/IIdentityNotification';

export class IdentityPushNotificationAccess {
  constructor(
    private readonly groupsService: Pick<
      UserGroupsService,
      'getGroupsUserIsEligibleFor'
    >,
    private readonly wavesDb: Pick<WavesApiDb, 'findWavesByIds'>,
    private readonly dataSourceSupplier: () => Pick<DataSource, 'getRepository'>
  ) {}

  async canRecipientReadWave(
    identityId: string,
    waveId: string
  ): Promise<boolean> {
    const eligibleGroupIds =
      await this.groupsService.getGroupsUserIsEligibleFor(identityId);
    const visibleWaves = await this.wavesDb.findWavesByIds(
      [waveId],
      eligibleGroupIds
    );
    return visibleWaves.some((wave) => wave.id === waveId);
  }

  async canRecipientReadRelatedContent(
    notification: IdentityNotificationEntity,
    waveAccessCache?: Map<string, Promise<boolean>>
  ): Promise<boolean> {
    if (
      notification.cause === IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED
    ) {
      const data =
        notification.additional_data as unknown as ArtistArtworkNotificationData;
      const current = await artistArtworkSubmissionDb.find(
        {
          competition_id: data.competition_id,
          competition_entry_id: data.entry_id,
          drop_id: notification.related_drop_id ?? undefined,
          wave_id: notification.wave_id ?? ''
        },
        {}
      );
      if (
        !current ||
        !(await artistArtworkAlertsDb.isEnabled(
          {
            subscriberId: notification.identity_id,
            artistId: current.artist_id
          },
          {},
          current.submitted_at
        ))
      )
        return false;
    }
    const waveId = notification.wave_id;
    if (!waveId) {
      return true;
    }

    const waveAccessKey = `${notification.identity_id}:${waveId}`;
    let canReadWave = waveAccessCache?.get(waveAccessKey);
    if (!canReadWave) {
      canReadWave = this.canRecipientReadWave(notification.identity_id, waveId);
      waveAccessCache?.set(waveAccessKey, canReadWave);
    }
    if (!(await canReadWave)) {
      return false;
    }

    // Push bodies are rendered from the primary related drop. Secondary drops
    // may legitimately belong to another wave for cross-wave quote/reply
    // notifications, so they are not part of this content-access check.
    const relatedDropIds = notification.related_drop_id
      ? [notification.related_drop_id]
      : [];
    if (!relatedDropIds.length) {
      return true;
    }

    const relatedDrops = await this.dataSourceSupplier()
      .getRepository(DropEntity)
      .find({
        where: { id: In(relatedDropIds) },
        select: { id: true, wave_id: true }
      });
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
