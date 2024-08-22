import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
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
import { Timer } from '../../../time';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { DropQuoteNotificationData } from '../../../notifications/user-notification.types';
import { CreateDropPart } from '../generated/models/CreateDropPart';
import { RequestContext } from '../../../request.context';

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
    authenticationContext: AuthenticationContext,
    timer: Timer
  ): Promise<Drop> {
    timer.start(`dropCreationApiService->createDrop`);
    await this.validateReferences(
      createDropRequest,
      authenticationContext,
      false,
      timer
    );
    const dropFull = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.persistDrop(
          createDropRequest,
          authenticationContext,
          false,
          connection,
          timer
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
    this.logger.info(
      `Drop ${dropFull.id} created by user ${dropFull.author.id}`
    );
    timer.stop(`dropCreationApiService->createDrop`);
    return dropFull;
  }

  async createWaveDrop(
    waveId: string,
    createWaveDropRequest: CreateWaveDropRequest,
    ctx: RequestContext
  ): Promise<Drop> {
    const createDropRequest: CreateDropRequest = {
      ...createWaveDropRequest,
      wave_id: waveId
    };
    const authenticationContext = ctx.authenticationContext!;
    const timer = ctx.timer!;
    const connection = ctx.connection!;
    await this.validateReferences(
      createDropRequest,
      authenticationContext,
      true,
      timer
    );
    const dropFull = await this.persistDrop(
      createDropRequest,
      authenticationContext,
      true,
      connection,
      timer
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
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    const createDropParts = createDropRequest.parts;
    const authorId = authenticationContext.getActingAsId()!;
    timer.start('dropCreationApiService->insertDrop');
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
    timer.stop('dropCreationApiService->insertDrop');
    timer.start('dropCreationApiService->findWaveVisibilityGroupByDropId');
    const visibilityGroupId = await wavesApiDb.findWaveVisibilityGroupByDropId(
      dropId,
      connection
    );
    timer.stop('dropCreationApiService->findWaveVisibilityGroupByDropId');

    await Promise.all([
      this.createDropReplyNotifications(
        createDropRequest,
        timer,
        connection,
        dropId,
        visibilityGroupId
      ),
      identitySubscriptionsDb.addIdentitySubscription(
        {
          subscriber_id: authorId,
          target_id: dropId.toString(),
          target_type: ActivityEventTargetType.DROP,
          target_action: ActivityEventAction.DROP_VOTED
        },
        connection,
        timer
      ),
      identitySubscriptionsDb.addIdentitySubscription(
        {
          subscriber_id: authorId,
          target_id: dropId.toString(),
          target_type: ActivityEventTargetType.DROP,
          target_action: ActivityEventAction.DROP_REPLIED
        },
        connection,
        timer
      ),
      this.recordDropCreatedActivity(
        isDescriptionDrop,
        dropId,
        authorId,
        createDropRequest,
        visibilityGroupId,
        connection,
        timer
      ),
      this.profileActivityLogsDb.insert(
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
        connection,
        timer
      ),
      this.insertMentionsInDrop(
        timer,
        createDropRequest,
        dropId,
        authorId,
        visibilityGroupId,
        connection
      ),
      this.dropsDb.insertReferencedNfts(
        Object.values(
          createDropRequest.referenced_nfts.reduce<
            Record<string, DropReferencedNFT>
          >((acc, it) => {
            acc[JSON.stringify(it)] = it;
            return acc;
          }, {} as Record<string, DropReferencedNFT>)
        ).map((it) => ({
          drop_id: dropId,
          contract: it.contract,
          token: it.token,
          name: it.name
        })),
        connection,
        timer
      ),
      this.dropsDb.insertDropMetadata(
        createDropRequest.metadata.map((it) => ({
          ...it,
          drop_id: dropId
        })),
        connection,
        timer
      ),
      this.dropsDb.insertDropMedia(
        createDropParts
          .map(
            (part, index) =>
              part.media?.map<Omit<DropMediaEntity, 'id'>>((media) => ({
                ...media,
                drop_id: dropId,
                drop_part_id: index + 1
              })) ?? []
          )
          .flat(),
        connection,
        timer
      ),
      this.dropsDb.insertDropParts(
        createDropParts.map<DropPartEntity>((part, index) => ({
          drop_id: dropId,
          drop_part_id: index + 1,
          content: part.content ?? null,
          quoted_drop_id: part.quoted_drop?.drop_id ?? null,
          quoted_drop_part_id: part.quoted_drop?.drop_part_id ?? null
        })),
        connection,
        timer
      ),
      this.recordQuoteNotifications(
        timer,
        createDropParts,
        connection,
        dropId,
        visibilityGroupId
      )
    ]);

    timer.start('dropCreationApiService->findInsertedDropAndConstructForApi');
    const drop = await this.dropsService.findDropByIdOrThrow(
      {
        dropId,
        authenticationContext,
        min_part_id: 0,
        max_part_id: Number.MAX_SAFE_INTEGER,
        skipEligibilityCheck: true
      },
      connection
    );
    timer.stop('dropCreationApiService->findInsertedDropAndConstructForApi');
    return drop;
  }

  private async recordQuoteNotifications(
    timer: Timer,
    createDropParts: CreateDropPart[],
    connection: ConnectionWrapper<any>,
    dropId: string,
    visibilityGroupId: string | null
  ) {
    timer.start('dropCreationApiService->notifyOfDropQuotes');
    let idx = 1;
    const quoteNotificationDatas: DropQuoteNotificationData[] = [];
    for (const createDropPart of createDropParts) {
      const quotedDrop = createDropPart.quoted_drop;
      if (quotedDrop) {
        const quotedEntity = await this.dropsDb
          .getDropsByIds([quotedDrop.drop_id], connection)
          .then((it) => it[0]);
        quoteNotificationDatas.push({
          quote_drop_id: dropId,
          quote_drop_part: idx,
          quote_drop_author_id: quotedEntity.author_id,
          quoted_drop_id: quotedDrop.drop_id,
          quoted_drop_part: quotedDrop.drop_part_id,
          quoted_drop_author_id: quotedEntity.author_id
        });
      }
      idx++;
    }
    await Promise.all(
      quoteNotificationDatas.map((it) =>
        this.userNotifier.notifyOfDropQuote(
          it,
          visibilityGroupId,
          connection,
          timer
        )
      )
    );
    timer.stop('dropCreationApiService->notifyOfDropQuotes');
  }

  private async insertMentionsInDrop(
    timer: Timer,
    createDropRequest: CreateDropRequest,
    dropId: string,
    authorId: string,
    visibilityGroupId: string | null,
    connection: ConnectionWrapper<any>
  ) {
    timer.start('dropCreationApiService->insertMentions');
    const mentionEntities = createDropRequest.mentioned_users.map((it) => ({
      drop_id: dropId,
      mentioned_profile_id: it.mentioned_profile_id,
      handle_in_content: it.handle_in_content
    }));
    await Promise.all([
      ...mentionEntities.map((mentionEntity) =>
        this.userNotifier.notifyOfIdentityMention(
          {
            mentioned_identity_id: mentionEntity.mentioned_profile_id,
            drop_id: dropId,
            mentioner_identity_id: authorId
          },
          visibilityGroupId,
          connection,
          timer
        )
      ),
      this.dropsDb.insertMentions(mentionEntities, connection)
    ]);
    timer.stop('dropCreationApiService->insertMentions');
  }

  private async recordDropCreatedActivity(
    isDescriptionDrop: boolean,
    dropId: string,
    authorId: string,
    createDropRequest: CreateDropRequest,
    visibilityGroupId: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    if (!isDescriptionDrop) {
      await this.activityRecorder.recordDropCreated(
        {
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
        },
        connection,
        timer
      );
    }
  }

  private async createDropReplyNotifications(
    createDropRequest: CreateDropRequest,
    timer: Timer,
    connection: ConnectionWrapper<any>,
    dropId: string,
    visibilityGroupId: string | null
  ) {
    const replyTo = createDropRequest.reply_to;
    if (replyTo) {
      timer.start('dropCreationApiService->getReplyDropEntity');
      const replyToEntity = await this.dropsDb
        .getDropsByIds([replyTo.drop_id], connection)
        .then((r) => r[0]);
      timer.stop('dropCreationApiService->getReplyDropEntity');
      timer.start('dropCreationApiService->notifyOfDropReply');
      await this.userNotifier.notifyOfDropReply(
        {
          reply_drop_id: dropId,
          reply_drop_author_id: replyToEntity.author_id,
          replied_drop_id: replyTo.drop_id,
          replied_drop_part: replyTo.drop_part_id,
          replied_drop_author_id: replyToEntity.author_id
        },
        visibilityGroupId,
        connection,
        timer
      );
      timer.stop('dropCreationApiService->notifyOfDropReply');
    }
  }

  private async validateReferences(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext,
    skipWaveIdCheck: boolean,
    timer: Timer
  ) {
    timer.start('dropCreationApiService->validateReferences');
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticationContext.getActingAsId(),
        timer
      );

    await Promise.all([
      skipWaveIdCheck
        ? Promise.resolve()
        : this.verifyWaveLimitations(
            createDropRequest,
            groupIdsUserIsEligibleFor,
            authenticationContext,
            timer
          ),
      this.verifyQuotedDrops(createDropRequest, timer),
      this.verifyReplyDrop(createDropRequest, timer)
    ]);
    timer.stop('dropCreationApiService->validateReferences');
  }

  private async verifyReplyDrop(
    createDropRequest: CreateDropRequest,
    timer: Timer
  ) {
    const replyTo = createDropRequest.reply_to;
    if (replyTo) {
      timer.start('dropCreationApiService->verifyReplyDrop');
      const dropId = replyTo.drop_id;
      const dropPartId = replyTo.drop_part_id;
      const replyToEntity = await this.dropsDb
        .getDropsByIds([dropId])
        .then(
          (res) =>
            res.find(
              (it) => it.id === dropId && it.parts_count >= dropPartId
            ) ?? null
        );
      timer.stop('dropCreationApiService->verifyReplyDrop');
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

  private async verifyQuotedDrops(
    createDropRequest: CreateDropRequest,
    timer: Timer
  ) {
    const quotedDrops = createDropRequest.parts
      .map<QuotedDrop | null | undefined>((it) => it.quoted_drop)
      .filter((it) => it !== undefined && it !== null) as QuotedDrop[];
    if (quotedDrops.length) {
      timer.start('dropCreationApiService->verifyQuotedDrops');
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
      timer.stop('dropCreationApiService->verifyQuotedDrops');
      if (invalidQuotedDrops.length) {
        throw new BadRequestException(
          `Invalid quoted drops: ${invalidQuotedDrops
            .map((it) => `${it.drop_id}/${it.drop_part_id}`)
            .join(', ')}`
        );
      }
    }
  }

  private async verifyWaveLimitations(
    createDropRequest: CreateDropRequest,
    groupIdsUserIsEligibleFor: string[],
    authenticationContext: AuthenticationContext,
    timer: Timer
  ) {
    timer.start('dropCreationApiService->verifyWaveLimitations');
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
      authenticationContext.getActingAsId()!,
      timer
    );
    timer.stop('dropCreationApiService->verifyWaveLimitations');
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

  private async verifyParticipatoryLimitations(
    wave: Wave,
    author_id: string,
    timer: Timer
  ) {
    timer.start('dropCreationApiService->verifyParticipatoryLimitations');
    const noOfApplicationsAllowedPerParticipant =
      wave.participation.no_of_applications_allowed_per_participant;
    if (noOfApplicationsAllowedPerParticipant !== null) {
      const countOfDropsByAuthorInWave =
        await this.dropsDb.countAuthorDropsInWave({
          wave_id: wave.id,
          author_id
        });
      timer.stop('dropCreationApiService->verifyParticipatoryLimitations');
      if (countOfDropsByAuthorInWave >= noOfApplicationsAllowedPerParticipant) {
        throw new ForbiddenException(
          `Wave allows ${noOfApplicationsAllowedPerParticipant} drops per participant. User has dropped applied ${countOfDropsByAuthorInWave} times.`
        );
      }
    } else {
      timer.stop('dropCreationApiService->verifyParticipatoryLimitations');
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
