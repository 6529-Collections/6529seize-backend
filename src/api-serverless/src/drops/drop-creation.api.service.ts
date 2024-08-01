import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Logger } from '../../../logging';
import { DropsApiService, dropsService } from './drops.api.service';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { Drop } from '../generated/models/Drop';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';
import { QuotedDrop } from '../generated/models/QuotedDrop';
import { DropMediaEntity, DropPartEntity } from '../../../entities/IDrop';
import { waveApiService } from '../waves/wave.api.service';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '../../../auth-context';
import { ConnectionWrapper } from '../../../sql-executor';
import { CreateWaveDropRequest } from '../generated/models/CreateWaveDropRequest';
import { assertUnreachable, parseNumberOrNull } from '../../../helpers';
import { WaveParticipationRequirement } from '../generated/models/WaveParticipationRequirement';
import { WaveMetadataType } from '../generated/models/WaveMetadataType';
import { Wave } from '../generated/models/Wave';
import {
  activityRecorder,
  ActivityRecorder
} from '../../../activity/activity.recorder';
import { wavesApiDb } from '../waves/waves.api.db';
import { identitySubscriptionsDb } from '../identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';

export class DropCreationApiService {
  private readonly logger = Logger.get(DropCreationApiService.name);

  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly activityRecorder: ActivityRecorder,
    private readonly userNotifier: UserNotifier
  ) {}

  async createDrop(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext
  ): Promise<Drop> {
    await this.validateReferences(
      createDropRequest,
      authenticationContext,
      false
    );
    const dropFull = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.persistDrop(
          createDropRequest,
          authenticationContext,
          false,
          connection
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
    this.logger.info(
      `Drop ${dropFull.id} created by user ${dropFull.author.id}`
    );
    return dropFull;
  }

  async createWaveDrop(
    waveId: string,
    createWaveDropRequest: CreateWaveDropRequest,
    authenticationContext: AuthenticationContext,
    connection: ConnectionWrapper<any>
  ): Promise<Drop> {
    const createDropRequest: CreateDropRequest = {
      ...createWaveDropRequest,
      wave_id: waveId
    };
    await this.validateReferences(
      createDropRequest,
      authenticationContext,
      true
    );
    const dropFull = await this.persistDrop(
      createDropRequest,
      authenticationContext,
      true,
      connection
    );
    this.logger.info(
      `Drop ${dropFull.id} created by user ${dropFull.author.id}`
    );
    return dropFull;
  }

  private async persistDrop(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext,
    isDescriptionDrop: boolean,
    connection: ConnectionWrapper<any>
  ) {
    const createDropParts = createDropRequest.parts;
    const authorId = authenticationContext.getActingAsId()!;
    const dropId = await this.dropsDb.insertDrop(
      {
        author_id: authorId,
        title: createDropRequest.title ?? null,
        parts_count: createDropParts.length,
        wave_id: createDropRequest.wave_id,
        reply_to_drop_id: createDropRequest.reply_to?.drop_id ?? null,
        reply_to_part_id: createDropRequest.reply_to?.drop_part_id ?? null
      },
      connection
    );
    const visibilityGroupId = await wavesApiDb.findWaveVisibilityGroupByDropId(
      dropId,
      connection
    );
    if (createDropRequest.reply_to) {
      const replyToEntity = await this.dropsDb
        .getDropsByIds([createDropRequest.reply_to.drop_id], connection)
        .then((it) => it[0]);
      await this.userNotifier.notifyOfDropReply(
        {
          reply_drop_id: dropId,
          reply_drop_author_id: replyToEntity.author_id,
          replied_drop_id: createDropRequest.reply_to.drop_id,
          replied_drop_part: createDropRequest.reply_to.drop_part_id,
          replied_drop_author_id: replyToEntity.author_id
        },
        visibilityGroupId
      );
    }
    await identitySubscriptionsDb.addIdentitySubscription(
      {
        subscriber_id: authorId,
        target_id: dropId.toString(),
        target_type: ActivityEventTargetType.DROP,
        target_action: ActivityEventAction.DROP_VOTED
      },
      connection
    );
    await identitySubscriptionsDb.addIdentitySubscription(
      {
        subscriber_id: authorId,
        target_id: dropId.toString(),
        target_type: ActivityEventTargetType.DROP,
        target_action: ActivityEventAction.DROP_REPLIED
      },
      connection
    );
    if (!isDescriptionDrop) {
      await this.activityRecorder.recordDropCreated({
        drop_id: dropId,
        creator_id: authorId,
        wave_id: createDropRequest.wave_id,
        visibility_group_id: visibilityGroupId,
        reply_to: createDropRequest.reply_to
          ? {
              drop_id: createDropRequest.reply_to.drop_id,
              part_id: createDropRequest.reply_to.drop_part_id
            }
          : null
      });
    }
    await this.profileActivityLogsDb.insert(
      {
        profile_id: authorId,
        target_id: dropId.toString(),
        contents: JSON.stringify({
          drop_id: dropId,
          proxy_id: authenticationContext.isAuthenticatedAsProxy()
            ? authenticationContext.authenticatedProfileId
            : undefined
        }),
        type: ProfileActivityLogType.DROP_CREATED,
        proxy_id: authenticationContext.isAuthenticatedAsProxy()
          ? authenticationContext.authenticatedProfileId!
          : null
      },
      connection
    );
    const mentionEntities = createDropRequest.mentioned_users.map((it) => ({
      drop_id: dropId,
      mentioned_profile_id: it.mentioned_profile_id,
      handle_in_content: it.handle_in_content
    }));
    for (const mentionEntity of mentionEntities) {
      await this.userNotifier.notifyOfIdentityMention(
        {
          mentioned_identity_id: mentionEntity.mentioned_profile_id,
          drop_id: dropId,
          mentioner_identity_id: authorId
        },
        visibilityGroupId,
        connection
      );
    }
    await this.dropsDb.insertMentions(mentionEntities, connection);
    const referencedNfts = Object.values(
      createDropRequest.referenced_nfts.reduce<
        Record<string, DropReferencedNFT>
      >((acc, it) => {
        acc[JSON.stringify(it)] = it;
        return acc;
      }, {} as Record<string, DropReferencedNFT>)
    );
    await this.dropsDb.insertReferencedNfts(
      referencedNfts.map((it) => ({
        drop_id: dropId,
        contract: it.contract,
        token: it.token,
        name: it.name
      })),
      connection
    );
    const metadata = createDropRequest.metadata.map((it) => ({
      ...it,
      drop_id: dropId
    }));
    await this.dropsDb.insertDropMetadata(metadata, connection);
    const media = createDropParts
      .map(
        (part, index) =>
          part.media?.map<Omit<DropMediaEntity, 'id'>>((media) => ({
            ...media,
            drop_id: dropId,
            drop_part_id: index + 1
          })) ?? []
      )
      .flat();
    await this.dropsDb.insertDropMedia(media, connection);
    await this.dropsDb.insertDropParts(
      createDropParts.map<DropPartEntity>((part, index) => ({
        drop_id: dropId,
        drop_part_id: index + 1,
        content: part.content ?? null,
        quoted_drop_id: part.quoted_drop?.drop_id ?? null,
        quoted_drop_part_id: part.quoted_drop?.drop_part_id ?? null
      })),
      connection
    );
    let idx = 1;
    for (const createDropPart of createDropParts) {
      const quotedDrop = createDropPart.quoted_drop;
      if (quotedDrop) {
        const quotedEntity = await this.dropsDb
          .getDropsByIds([quotedDrop.drop_id], connection)
          .then((it) => it[0]);
        await this.userNotifier.notifyOfDropQuote(
          {
            quote_drop_id: dropId,
            quote_drop_part: idx,
            quote_drop_author_id: quotedEntity.author_id,
            quoted_drop_id: quotedDrop.drop_id,
            quoted_drop_part: quotedDrop.drop_part_id,
            quoted_drop_author_id: quotedEntity.author_id
          },
          visibilityGroupId
        );
      }
      idx++;
    }
    return this.dropsService.findDropByIdOrThrow(
      {
        dropId,
        authenticationContext,
        min_part_id: 0,
        max_part_id: Number.MAX_SAFE_INTEGER,
        skipEligibilityCheck: true
      },
      connection
    );
  }

  private async validateReferences(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext,
    skipWaveIdCheck: boolean
  ) {
    const quotedDrops = createDropRequest.parts
      .map<QuotedDrop | null | undefined>((it) => it.quoted_drop)
      .filter((it) => it !== undefined && it !== null) as QuotedDrop[];
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticationContext.getActingAsId()!
      );
    if (!skipWaveIdCheck) {
      await this.verifyWaveLimitations(
        createDropRequest,
        groupIdsUserIsEligibleFor,
        authenticationContext
      );
    }

    if (quotedDrops.length) {
      const dropIds = quotedDrops.map((it) => it.drop_id);
      const entities = await this.dropsDb.getDropsByIds(dropIds);
      const invalidQuotedDrops = quotedDrops.filter(
        (quotedDrop) =>
          !entities.find((it) => {
            return (
              it.id === quotedDrop.drop_id &&
              quotedDrop.drop_part_id <= it.parts_count
            );
          })
      );
      if (invalidQuotedDrops.length) {
        throw new BadRequestException(
          `Invalid quoted drops: ${invalidQuotedDrops
            .map((it) => `${it.drop_id}/${it.drop_part_id}`)
            .join(', ')}`
        );
      }
    }

    if (createDropRequest.reply_to) {
      const dropId = createDropRequest.reply_to.drop_id;
      const dropPartId = createDropRequest.reply_to.drop_part_id;
      const replyToEntity = await this.dropsDb
        .getDropsByIds([dropId])
        .then(
          (res) =>
            res.find(
              (it) => it.id === dropId && it.parts_count >= dropPartId
            ) ?? null
        );
      if (!replyToEntity) {
        throw new BadRequestException(
          `Invalid reply. Drop $${dropId}/${dropPartId} doesn't exist`
        );
      }
      if (replyToEntity.wave_id !== createDropRequest.wave_id) {
        throw new BadRequestException(
          `Invalid reply. Drop you are replying to is not in the same wave as you attempt to create a drop in`
        );
      }
    }
  }

  private async verifyWaveLimitations(
    createDropRequest: CreateDropRequest,
    groupIdsUserIsEligibleFor: string[],
    authenticationContext: AuthenticationContext
  ) {
    const wave = await waveApiService.findWaveByIdOrThrow(
      createDropRequest.wave_id,
      groupIdsUserIsEligibleFor,
      authenticationContext
    );
    const groupId = wave.participation.scope.group?.id;
    if (groupId && !groupIdsUserIsEligibleFor.includes(groupId)) {
      throw new ForbiddenException(`User is not eligible for this wave`);
    }
    if (!createDropRequest.reply_to?.drop_id) {
      this.verifyMedia(wave, createDropRequest);
      this.verifyMetadata(wave, createDropRequest);
    }
    await this.verifyParticipatoryLimitations(
      wave,
      authenticationContext.getActingAsId()!
    );
  }

  private verifyMetadata(wave: Wave, createDropRequest: CreateDropRequest) {
    for (const requiredMetadata of wave.participation.required_metadata) {
      const metadata = createDropRequest.metadata.filter(
        (it) => it.data_key === requiredMetadata.name
      );
      if (!metadata.length) {
        throw new BadRequestException(
          `Wave requires metadata ${requiredMetadata.name}`
        );
      }
      if (requiredMetadata.type === WaveMetadataType.Number) {
        if (!metadata.some((it) => parseNumberOrNull(it.data_value) !== null)) {
          throw new BadRequestException(
            `Wave requires metadata ${requiredMetadata.name} to be a number`
          );
        }
      }
    }
  }

  private verifyMedia(wave: Wave, createDropRequest: CreateDropRequest) {
    const requiredMedias = wave.participation.required_media;
    if (requiredMedias.length) {
      const mimeTypes = createDropRequest.parts
        .map((it) => it.media.map((media) => media.mime_type))
        .flat()
        .flat();
      for (const requiredMedia of requiredMedias) {
        let requiredMimeType: string | undefined = undefined;
        switch (requiredMedia) {
          case WaveParticipationRequirement.Image:
            requiredMimeType = mimeTypes.find((it) => it.startsWith('image/'));
            break;
          case WaveParticipationRequirement.Video:
            requiredMimeType = mimeTypes.find((it) => it.startsWith('video/'));
            break;
          case WaveParticipationRequirement.Audio:
            requiredMimeType = mimeTypes.find((it) => it.startsWith('audio/'));
            break;
          default:
            assertUnreachable(requiredMedia);
        }
        if (!requiredMimeType) {
          throw new BadRequestException(
            `Wave requires media of type ${requiredMedia}`
          );
        }
      }
    }
  }

  private async verifyParticipatoryLimitations(wave: Wave, author_id: string) {
    const noOfApplicationsAllowedPerParticipant =
      wave.participation.no_of_applications_allowed_per_participant;
    if (noOfApplicationsAllowedPerParticipant !== null) {
      const countOfDropsByAuthorInWave =
        await this.dropsDb.countAuthorDropsInWave({
          wave_id: wave.id,
          author_id
        });
      if (countOfDropsByAuthorInWave >= noOfApplicationsAllowedPerParticipant) {
        throw new ForbiddenException(
          `Wave allows ${noOfApplicationsAllowedPerParticipant} drops per participant. User has dropped applied ${countOfDropsByAuthorInWave} times.`
        );
      }
    }
  }
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  profileActivityLogsDb,
  userGroupsService,
  activityRecorder,
  userNotifier
);
