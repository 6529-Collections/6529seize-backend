import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
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
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '../../../auth-context';
import { ConnectionWrapper } from '../../../sql-executor';
import { CreateWaveDropRequest } from '../generated/models/CreateWaveDropRequest';
import {
  assertUnreachable,
  parseIntOrNull,
  parseNumberOrNull,
  resolveEnumOrThrow
} from '../../../helpers';
import { WaveParticipationRequirement } from '../generated/models/WaveParticipationRequirement';
import { WaveMetadataType } from '../generated/models/WaveMetadataType';
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
import { Time, Timer } from '../../../time';
import { DropQuoteNotificationData } from '../../../notifications/user-notification.types';
import { CreateDropPart } from '../generated/models/CreateDropPart';
import { ParticipationRequiredMedia } from '../../../entities/IWave';
import { RequestContext } from '../../../request.context';
import { dropRaterService } from './drop-rater.service';
import { UpdateDropRequest } from '../generated/models/UpdateDropRequest';
import * as process from 'node:process';
import { DropMentionedUser } from '../generated/models/DropMentionedUser';
import { ReplyToDrop } from '../generated/models/ReplyToDrop';
import { randomUUID } from 'crypto';

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
    request: CreateDropRequest,
    authenticationContext: AuthenticationContext,
    isDescriptionDrop: boolean,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    const authorId = authenticationContext.getActingAsId()!;
    const dropId = randomUUID();
    timer.start('dropCreationApiService->findWaveVisibilityGroupByDropId');
    const visibilityGroupId = await wavesApiDb.findWaveVisibilityGroupByWaveId(
      request.wave_id,
      connection
    );
    timer.stop('dropCreationApiService->findWaveVisibilityGroupByDropId');

    await this.insertAllDropComponents(
      {
        dropId,
        request,
        authorId,
        waveId: request.wave_id,
        replyTo: request.reply_to,
        createdAt: Time.currentMillis(),
        serialNo: null,
        updatedAt: Time.currentMillis(),
        visibilityGroupId,
        isDescriptionDrop
      },
      { authenticationContext, timer, connection }
    );

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
    waveId: string,
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
          quoted_drop_author_id: quotedEntity.author_id,
          wave_id: waveId
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
    mentionedUsers: DropMentionedUser[],
    dropId: string,
    waveId: string,
    authorId: string,
    visibilityGroupId: string | null,
    connection: ConnectionWrapper<any>
  ) {
    timer.start('dropCreationApiService->insertMentions');
    const mentionEntities = mentionedUsers.map((it) => ({
      drop_id: dropId,
      mentioned_profile_id: it.mentioned_profile_id,
      handle_in_content: it.handle_in_content,
      wave_id: waveId
    }));
    await Promise.all([
      ...mentionEntities.map((mentionEntity) =>
        this.userNotifier.notifyOfIdentityMention(
          {
            mentioned_identity_id: mentionEntity.mentioned_profile_id,
            drop_id: dropId,
            mentioner_identity_id: authorId,
            wave_id: waveId
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
    dropRequest:
      | CreateDropRequest
      | (UpdateDropRequest & { reply_to?: ReplyToDrop; wave_id: string }),
    visibilityGroupId: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    if (!isDescriptionDrop) {
      await this.activityRecorder.recordDropCreated(
        {
          drop_id: dropId,
          creator_id: authorId,
          wave_id: dropRequest.wave_id,
          visibility_group_id: visibilityGroupId,
          reply_to: dropRequest.reply_to
            ? {
                drop_id: dropRequest.reply_to.drop_id,
                part_id: dropRequest.reply_to.drop_part_id
              }
            : null
        },
        connection,
        timer
      );
    }
  }

  private async createDropReplyNotifications(
    createDropRequest:
      | CreateDropRequest
      | (UpdateDropRequest & { reply_to?: ReplyToDrop }),
    timer: Timer,
    connection: ConnectionWrapper<any>,
    dropId: string,
    waveId: string,
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
          replied_drop_author_id: replyToEntity.author_id,
          wave_id: waveId
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
    createDropRequest: CreateDropRequest | UpdateDropRequest,
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
    const waveId = createDropRequest.wave_id;
    const wave = await wavesApiDb.findWaveAccessibiltiyDataForDroping(waveId);
    if (!wave) {
      throw new BadRequestException(`Wave not found`);
    }
    const groupId = wave.participation_group_id;
    if (groupId && !groupIdsUserIsEligibleFor.includes(groupId)) {
      throw new ForbiddenException(`User is not eligible for this wave`);
    }

    const isReplyDrop = createDropRequest.reply_to?.drop_id;
    await Promise.all([
      this.verifyParticipatoryLimitations(
        waveId,
        wave.participation_max_applications_per_participant,
        authenticationContext.getActingAsId()!,
        timer
      ),
      isReplyDrop
        ? Promise.resolve()
        : this.verifyMedia(
            wave.participation_required_media,
            createDropRequest
          ),
      isReplyDrop
        ? Promise.resolve()
        : this.verifyMetadata(
            wave.participation_required_metadata,
            createDropRequest
          )
    ]);
    timer.stop('dropCreationApiService->verifyWaveLimitations');
  }

  private verifyMetadata(
    requiredMetadatas: any,
    createDropRequest: CreateDropRequest
  ) {
    for (const requiredMetadata of requiredMetadatas) {
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

  private verifyMedia(
    requiredMedias: ParticipationRequiredMedia[],
    createDropRequest: CreateDropRequest
  ) {
    if (requiredMedias.length) {
      const mimeTypes = createDropRequest.parts
        .map((it) => it.media.map((media) => media.mime_type))
        .flat()
        .flat();
      for (const requiredMedia of requiredMedias) {
        let requiredMimeType: string | undefined = undefined;
        const requiredMediaEnum = resolveEnumOrThrow(
          WaveParticipationRequirement,
          requiredMedia
        );
        switch (requiredMediaEnum) {
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
            assertUnreachable(requiredMediaEnum);
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
    waveId: string,
    noOfApplicationsAllowedPerParticipantInWave: number | null,
    author_id: string,
    timer: Timer
  ) {
    timer.start('dropCreationApiService->verifyParticipatoryLimitations');
    if (noOfApplicationsAllowedPerParticipantInWave !== null) {
      const countOfDropsByAuthorInWave =
        await this.dropsDb.countAuthorDropsInWave({
          wave_id: waveId,
          author_id
        });
      timer.stop('dropCreationApiService->verifyParticipatoryLimitations');
      if (
        countOfDropsByAuthorInWave >=
        noOfApplicationsAllowedPerParticipantInWave
      ) {
        throw new ForbiddenException(
          `Wave allows ${noOfApplicationsAllowedPerParticipantInWave} drops per participant. User has dropped applied ${countOfDropsByAuthorInWave} times.`
        );
      }
    } else {
      timer.stop('dropCreationApiService->verifyParticipatoryLimitations');
    }
  }

  public async deleteDrop(
    { id }: { id: string },
    { timer, authenticationContext }: RequestContext
  ) {
    timer?.start('dropCreationApiService->deleteDrop');
    const authenticatedProfileId = authenticationContext?.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to delete drops`);
    }
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      const ctxWithConnection = { timer, connection, authenticationContext };
      const dropEntity = await this.dropsDb.findDropByIdAndAuthor(
        { id, author_id: authenticatedProfileId },
        ctxWithConnection
      );
      if (!dropEntity) {
        throw new NotFoundException(
          `Drop ${id} not found or you are not the author`
        );
      }
      const waveId = dropEntity.wave_id;
      const wave = await this.dropsDb.findWaveByIdOrThrow(
        waveId,
        ctxWithConnection.connection
      );
      if (id === wave.description_drop_id) {
        throw new BadRequestException(
          `Cannot delete the description drop of a wave`
        );
      }
      await this.deleteAllDropComponentsById({ id, waveId }, ctxWithConnection);
    });
    timer?.stop('dropCreationApiService->deleteDrop');
  }

  private async deleteAllDropComponentsById(
    { id, waveId }: { id: string; waveId: string },
    ctxWithConnection: RequestContext
  ) {
    await Promise.all([
      this.dropsDb.deleteDropParts(id, ctxWithConnection),
      this.dropsDb.deleteDropMentions(id, ctxWithConnection),
      this.dropsDb.deleteDropMedia(id, ctxWithConnection),
      this.dropsDb.deleteDropReferencedNfts(id, ctxWithConnection),
      this.dropsDb.deleteDropMetadata(id, ctxWithConnection),
      this.dropsDb.deleteDropEntity(id, ctxWithConnection),
      this.dropsDb.updateWaveDropCounters(waveId, ctxWithConnection),
      dropRaterService.deleteDropVotes(id, ctxWithConnection),
      this.dropsDb.deleteDropFeedItems(id, ctxWithConnection),
      this.dropsDb.deleteDropNotifications(id, ctxWithConnection),
      this.dropsDb.deleteDropSubscriptions(id, ctxWithConnection)
    ]);
  }

  async updateDrop(
    { dropId, request }: { dropId: string; request: UpdateDropRequest },
    ctx: RequestContext
  ): Promise<Drop> {
    ctx.timer?.start(`dropCreationApiService->updateDrop`);
    const authenticationContext = ctx.authenticationContext!;
    const authorProfileId = authenticationContext.getActingAsId();
    if (!authorProfileId) {
      throw new ForbiddenException(
        'You need to create a profile before you can create a drop'
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to create drops`
      );
    }
    const updatedDrop = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const timer = ctxWithConnection.timer!;
        timer.start(`dropCreationApiService->updateDrop->findOldDrop`);
        const dropBeforeUpdate = await this.dropsService.findDropByIdOrThrow(
          {
            dropId,
            authenticationContext: authenticationContext,
            min_part_id: 0,
            max_part_id: Number.MAX_SAFE_INTEGER,
            skipEligibilityCheck: true
          },
          connection
        );
        timer.stop(`dropCreationApiService->updateDrop->findOldDrop`);
        const authorId = dropBeforeUpdate.author.id;
        if (authorId !== authenticationContext.getActingAsId()) {
          throw new ForbiddenException(`You are not the author of this drop`);
        }
        const dropLastTouched = Time.millis(
          dropBeforeUpdate.updated_at ?? dropBeforeUpdate.created_at
        );
        const maximumTimeAllowedForEdit = Time.millis(
          parseIntOrNull(process.env.MAX_DROP_EDIT_TIME_MS) ?? 0
        );
        if (dropLastTouched.diffFromNow().gt(maximumTimeAllowedForEdit)) {
          throw new ForbiddenException(
            `Drop can't be edited after ${maximumTimeAllowedForEdit}`
          );
        }
        await this.validateUpdateReferences(request, ctxWithConnection);

        const waveId = dropBeforeUpdate.wave.id;
        const visibilityGroupId =
          await wavesApiDb.findWaveVisibilityGroupByWaveId(waveId, connection);
        timer.start(`dropCreationApiService->deleteAllDropComponentsById`);
        await this.deleteAllDropComponentsById(
          { id: dropId, waveId },
          ctxWithConnection
        );
        timer.stop(`dropCreationApiService->deleteAllDropComponentsById`);
        timer.start(`dropCreationApiService->insertAllDropComponentsById`);
        const replyTo = dropBeforeUpdate.reply_to;
        const serialNo = dropBeforeUpdate.serial_no;
        await this.insertAllDropComponents(
          {
            dropId,
            request,
            authorId,
            waveId,
            replyTo,
            createdAt: dropBeforeUpdate.created_at,
            serialNo,
            updatedAt: Time.currentMillis(),
            visibilityGroupId,
            isDescriptionDrop:
              dropBeforeUpdate.wave.description_drop_id === dropId
          },
          { authenticationContext, timer, connection }
        );
        timer.stop(`dropCreationApiService->insertAllDropComponentsById`);
        return await this.dropsService.findDropByIdOrThrow(
          {
            dropId,
            authenticationContext: authenticationContext,
            min_part_id: 0,
            max_part_id: Number.MAX_SAFE_INTEGER,
            skipEligibilityCheck: true
          },
          connection
        );
      }
    );
    ctx.timer?.stop(`dropCreationApiService->updateDrop`);
    return updatedDrop;
  }

  private async insertAllDropComponents(
    {
      dropId,
      request,
      authorId,
      waveId,
      replyTo,
      createdAt,
      serialNo,
      visibilityGroupId,
      isDescriptionDrop,
      updatedAt
    }: {
      dropId: string;
      request: UpdateDropRequest | CreateDropRequest;
      authorId: string;
      waveId: string;
      replyTo?: ReplyToDrop;
      createdAt: number;
      updatedAt: number | null;
      serialNo: number | null;
      visibilityGroupId: string | null;
      isDescriptionDrop: boolean;
    },
    ctx: RequestContext
  ) {
    const connection = ctx.connection!;
    const timer = ctx.timer!;
    const authenticationContext = ctx.authenticationContext!;
    const parts = request.parts;
    await Promise.all([
      this.dropsDb.insertDrop(
        {
          id: dropId,
          author_id: authorId,
          title: request.title ?? null,
          parts_count: parts.length,
          wave_id: waveId,
          reply_to_drop_id: replyTo?.drop_id ?? null,
          reply_to_part_id: replyTo?.drop_part_id ?? null,
          created_at: createdAt,
          updated_at: updatedAt,
          serial_no: serialNo
        },
        connection
      ),
      this.createDropReplyNotifications(
        { ...request, reply_to: replyTo },
        timer,
        connection,
        dropId,
        waveId,
        visibilityGroupId
      ),
      identitySubscriptionsDb.addIdentitySubscription(
        {
          subscriber_id: authorId,
          target_id: dropId.toString(),
          target_type: ActivityEventTargetType.DROP,
          target_action: ActivityEventAction.DROP_VOTED,
          wave_id: waveId
        },
        connection,
        timer
      ),
      identitySubscriptionsDb.addIdentitySubscription(
        {
          subscriber_id: authorId,
          target_id: dropId.toString(),
          target_type: ActivityEventTargetType.DROP,
          target_action: ActivityEventAction.DROP_REPLIED,
          wave_id: waveId
        },
        connection,
        timer
      ),
      this.recordDropCreatedActivity(
        isDescriptionDrop,
        dropId,
        authorId,
        {
          ...request,
          reply_to: replyTo,
          wave_id: waveId
        },
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
        request.mentioned_users,
        dropId,
        waveId,
        authorId,
        visibilityGroupId,
        connection
      ),
      this.dropsDb.insertReferencedNfts(
        Object.values(
          request.referenced_nfts.reduce<Record<string, DropReferencedNFT>>(
            (acc, it) => {
              acc[JSON.stringify(it)] = it;
              return acc;
            },
            {} as Record<string, DropReferencedNFT>
          )
        ).map((it) => ({
          drop_id: dropId,
          contract: it.contract,
          token: it.token,
          name: it.name,
          wave_id: waveId
        })),
        connection,
        timer
      ),
      this.dropsDb.insertDropMetadata(
        request.metadata.map((it) => ({
          ...it,
          drop_id: dropId,
          wave_id: waveId
        })),
        connection,
        timer
      ),
      this.dropsDb.insertDropMedia(
        parts
          .map(
            (part, index) =>
              part.media?.map<Omit<DropMediaEntity, 'id'>>((media) => ({
                ...media,
                drop_id: dropId,
                drop_part_id: index + 1,
                wave_id: waveId
              })) ?? []
          )
          .flat(),
        connection,
        timer
      ),
      this.dropsDb.insertDropParts(
        parts.map<DropPartEntity>((part, index) => ({
          drop_id: dropId,
          drop_part_id: index + 1,
          content: part.content ?? null,
          quoted_drop_id: part.quoted_drop?.drop_id ?? null,
          quoted_drop_part_id: part.quoted_drop?.drop_part_id ?? null,
          wave_id: waveId
        })),
        connection,
        timer
      ),
      this.recordQuoteNotifications(
        timer,
        parts,
        connection,
        dropId,
        waveId,
        visibilityGroupId
      )
    ]);
  }

  private async validateUpdateReferences(
    request: UpdateDropRequest,
    ctx: RequestContext
  ) {
    const timer = ctx.timer!;
    timer.start('dropCreationApiService->validateReferences');
    await this.verifyQuotedDrops(request, timer);
    timer.stop('dropCreationApiService->validateReferences');
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
