import {
  CreateOrUpdateDropModel,
  DropPartIdentifierModel,
  DropReferencedNftModel
} from './create-or-update-drop.model';
import { Time, Timer } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { dropsDb, DropsDb } from './drops.db';
import {
  userGroupsService,
  UserGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import {
  wavesApiDb,
  WavesApiDb
} from '../api-serverless/src/waves/waves.api.db';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../exceptions';
import {
  ParticipationRequiredMedia,
  WaveEntity,
  WaveRequiredMetadataItemType
} from '../entities/IWave';
import {
  assertUnreachable,
  parseIntOrNull,
  parseNumberOrNull
} from '../helpers';
import { randomUUID } from 'crypto';
import {
  DropMediaEntity,
  DropMentionEntity,
  DropPartEntity,
  DropType
} from '../entities/IDrop';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../api-serverless/src/identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../entities/IActivityEvent';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { DropQuoteNotificationData } from '../notifications/user-notification.types';
import { userNotifier, UserNotifier } from '../notifications/user.notifier';
import {
  activityRecorder,
  ActivityRecorder
} from '../activity/activity.recorder';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import {
  profileProxyApiService,
  ProfileProxyApiService
} from '../api-serverless/src/proxies/proxy.api.service';
import { ApiProfileProxyActionType } from '../entities/IProfileProxyAction';
import { profilesDb, ProfilesDb } from '../profiles/profiles.db';
import process from 'node:process';
import { dropRaterService } from '../api-serverless/src/drops/drop-rater.service';

export class CreateOrUpdateDropUseCase {
  public constructor(
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly profileService: ProfilesService,
    private readonly profilesDb: ProfilesDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userNotifier: UserNotifier,
    private readonly activityRecorder: ActivityRecorder,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly proxyService: ProfileProxyApiService
  ) {}

  public async execute(
    model: CreateOrUpdateDropModel,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<{ drop_id: string }> {
    timer.start(`${CreateOrUpdateDropUseCase.name}->execute`);
    const authorId = model.author_id;
    const proxyIdNecessary = !!model.proxy_identity && !model.proxy_id;
    if (!authorId) {
      const authorIdentity = model.author_identity;
      const resolvedAuthorId =
        await this.profileService.resolveIdentityIdOrThrowNotFound(
          authorIdentity
        );
      return this.execute(
        { ...model, author_id: resolvedAuthorId },
        { timer, connection }
      );
    } else if (proxyIdNecessary) {
      const proxyIdentity = model.proxy_identity;
      const resolvedProxyId =
        await this.profileService.resolveIdentityIdOrThrowNotFound(
          proxyIdentity
        );
      const hasRequiredProxyAction =
        await this.proxyService.hasActiveProxyAction({
          granted_by_profile_id: authorId,
          granted_to_profile_id: resolvedProxyId,
          action: ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
        });
      if (!hasRequiredProxyAction) {
        throw new BadRequestException(
          `Identity ${model.author_identity} hasn't allowed identity ${model.proxy_identity} to create drops on it's behalf`
        );
      }
      return this.execute(
        { ...model, proxy_id: resolvedProxyId },
        { timer, connection }
      );
    }
    return await this.createOrUpdateDrop(model, { timer, connection });
  }

  private async createOrUpdateDrop(
    model: CreateOrUpdateDropModel,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    await this.validateReferences(model, { timer, connection });
    const preExistingDropId = model.drop_id;
    const wave = (await this.wavesApiDb.findById(model.wave_id, connection))!;
    let dropId: string;
    if (preExistingDropId) {
      dropId = preExistingDropId;
      const dropBeforeUpdate = await this.dropsDb.findDropById(
        dropId,
        connection
      );
      if (dropBeforeUpdate === null) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }
      if (dropBeforeUpdate.wave_id !== model.wave_id) {
        throw new BadRequestException("Can't change wave of a drop");
      }
      if (dropBeforeUpdate.author_id !== model.author_id) {
        throw new ForbiddenException(
          "Only author can change it's drop. You are not the author of this drop"
        );
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
      await this.deleteAllDropComponentsById(model, { connection, timer });
      await this.insertAllDropComponents(
        {
          model: { ...model, drop_id: dropId },
          createdAt: dropBeforeUpdate.created_at,
          serialNo: dropBeforeUpdate.serial_no,
          updatedAt: Time.currentMillis(),
          wave
        },
        { connection, timer }
      );
    } else {
      dropId = randomUUID();
      await this.insertAllDropComponents(
        {
          model: { ...model, drop_id: dropId },
          createdAt: Time.currentMillis(),
          serialNo: null,
          updatedAt: null,
          wave
        },
        { connection, timer }
      );
    }
    timer.stop(`${CreateOrUpdateDropUseCase.name}->execute`);
    return { drop_id: dropId };
  }

  private async validateReferences(
    model: CreateOrUpdateDropModel,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->validateReferences`);
    const authorId = model.author_id!;
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(authorId, timer);

    await Promise.all([
      this.verifyWaveLimitations(
        { model, groupIdsUserIsEligibleFor },
        { timer, connection }
      ),
      this.verifyQuotedDrops(model, { timer, connection }),
      this.verifyReplyDrop(model, { timer, connection })
    ]);
    timer.stop(`${CreateOrUpdateDropUseCase.name}->validateReferences`);
  }

  private async verifyWaveLimitations(
    {
      model,
      groupIdsUserIsEligibleFor
    }: { model: CreateOrUpdateDropModel; groupIdsUserIsEligibleFor: string[] },
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->verifyWaveLimitations`);
    const waveId = model.wave_id;
    const wave = await this.wavesApiDb.findById(waveId, connection);
    if (!wave) {
      throw new BadRequestException(`Wave ${waveId} not found`);
    }
    const groupId = wave.participation_group_id;
    if (groupId && !groupIdsUserIsEligibleFor.includes(groupId)) {
      throw new ForbiddenException(`User is not eligible for this wave`);
    }
    await Promise.all([
      this.verifyParticipatoryLimitations(
        {
          wave,
          model
        },
        { timer, connection }
      ),
      this.verifyMedia(
        {
          wave,
          model
        },
        { timer, connection }
      ),
      this.verifyMetadata(
        {
          wave,
          model
        },
        { timer, connection }
      )
    ]);
    timer.stop(`${CreateOrUpdateDropUseCase.name}->verifyWaveLimitations`);
  }

  private async verifyParticipatoryLimitations(
    {
      wave,
      model
    }: {
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
    },
    { timer }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start(
      `${CreateOrUpdateDropUseCase.name}->verifyParticipatoryLimitations`
    );
    const noOfApplicationsAllowedPerParticipantInWave =
      wave.participation_max_applications_per_participant;
    if (noOfApplicationsAllowedPerParticipantInWave !== null) {
      const countOfDropsByAuthorInWave =
        await this.dropsDb.countAuthorDropsInWave({
          wave_id: wave.id,
          author_id: model.author_id!
        });
      timer.stop(
        `${CreateOrUpdateDropUseCase.name}->verifyParticipatoryLimitations`
      );
      if (
        countOfDropsByAuthorInWave >=
        noOfApplicationsAllowedPerParticipantInWave
      ) {
        throw new ForbiddenException(
          `Wave allows ${noOfApplicationsAllowedPerParticipantInWave} drops per participant. User has dropped applied ${countOfDropsByAuthorInWave} times.`
        );
      }
    } else {
      timer.stop(
        `${CreateOrUpdateDropUseCase.name}->verifyParticipatoryLimitations`
      );
    }
  }

  private async verifyMedia(
    {
      wave,
      model
    }: {
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
    },
    { timer }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->verifyMedia`);
    const requiredMedias = wave.participation_required_media;
    if (requiredMedias.length) {
      const mimeTypes = model.parts
        .map((it) => it.media.map((media) => media.mime_type))
        .flat()
        .flat();
      for (const requiredMedia of requiredMedias) {
        let requiredMimeType: string | undefined = undefined;
        switch (requiredMedia) {
          case ParticipationRequiredMedia.IMAGE:
            requiredMimeType = mimeTypes.find((it) => it.startsWith('image/'));
            break;
          case ParticipationRequiredMedia.VIDEO:
            requiredMimeType = mimeTypes.find((it) => it.startsWith('video/'));
            break;
          case ParticipationRequiredMedia.AUDIO:
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
    timer.stop(`${CreateOrUpdateDropUseCase.name}->verifyMedia`);
  }

  private async verifyMetadata(
    {
      wave,
      model
    }: {
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
    },
    { timer }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->verifyMetadata`);
    const requiredMetadatas = wave.participation_required_metadata;
    for (const requiredMetadata of requiredMetadatas) {
      const metadata = model.metadata.filter(
        (it) => it.data_key === requiredMetadata.name
      );
      if (!metadata.length) {
        throw new BadRequestException(
          `Wave requires metadata ${requiredMetadata.name}`
        );
      }
      if (requiredMetadata.type === WaveRequiredMetadataItemType.NUMBER) {
        if (!metadata.some((it) => parseNumberOrNull(it.data_value) !== null)) {
          throw new BadRequestException(
            `Wave requires metadata ${requiredMetadata.name} to be a number`
          );
        }
      }
    }
    timer.stop(`${CreateOrUpdateDropUseCase.name}->verifyMetadata`);
  }

  private async verifyQuotedDrops(
    model: CreateOrUpdateDropModel,
    {
      timer
    }: {
      timer: Timer;
      connection: ConnectionWrapper<any>;
    }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->verifyQuotedDrops`);
    const quotedDrops = model.parts
      .map<DropPartIdentifierModel | null | undefined>((it) => it.quoted_drop)
      .filter(
        (it) => it !== undefined && it !== null
      ) as DropPartIdentifierModel[];
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
    timer.stop(`${CreateOrUpdateDropUseCase.name}->verifyQuotedDrops`);
  }

  private async verifyReplyDrop(
    model: CreateOrUpdateDropModel,
    {
      timer
    }: {
      timer: Timer;
      connection: ConnectionWrapper<any>;
    }
  ) {
    const replyTo = model.reply_to;
    timer.start(`${CreateOrUpdateDropUseCase.name}->verifyReplyDrop`);
    if (replyTo) {
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
      if (!replyToEntity) {
        throw new BadRequestException(
          `Invalid reply. Drop $${dropId}/${dropPartId} doesn't exist`
        );
      }
      if (replyToEntity.wave_id !== model.wave_id) {
        throw new BadRequestException(
          `Invalid reply. Drop you are replying to is not in the same wave as you attempt to create a drop in`
        );
      }
    }
    timer.stop(`${CreateOrUpdateDropUseCase.name}->verifyReplyDrop`);
  }

  private async insertAllDropComponents(
    {
      model,
      wave,
      createdAt,
      updatedAt,
      serialNo
    }: {
      model: CreateOrUpdateDropModel;
      wave: WaveEntity;
      createdAt: number;
      updatedAt: number | null;
      serialNo: number | null;
    },
    { connection, timer }: { connection: ConnectionWrapper<any>; timer: Timer }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->insertAllDropComponents`);
    const dropId = model.drop_id!;
    const authorId = model.author_id!;
    const parts = model.parts;
    await Promise.all([
      this.dropsDb.insertDrop(
        {
          id: dropId,
          author_id: authorId,
          title: model.title,
          parts_count: parts.length,
          wave_id: model.wave_id,
          reply_to_drop_id: model.reply_to?.drop_id ?? null,
          reply_to_part_id: model.reply_to?.drop_part_id ?? null,
          created_at: createdAt,
          updated_at: updatedAt,
          serial_no: serialNo,
          drop_type: DropType.CHAT
        },
        connection
      ),
      this.createDropReplyNotifications({ model, wave }, { timer, connection }),
      this.identitySubscriptionsDb.addIdentitySubscription(
        {
          subscriber_id: authorId,
          target_id: dropId.toString(),
          target_type: ActivityEventTargetType.DROP,
          target_action: ActivityEventAction.DROP_REPLIED,
          wave_id: wave.id
        },
        connection,
        timer
      ),
      this.recordDropCreatedActivity({ model, wave }, { timer, connection }),
      this.profileActivityLogsDb.insert(
        {
          profile_id: authorId,
          target_id: dropId.toString(),
          contents: JSON.stringify({
            drop_id: dropId,
            proxy_id: model.proxy_id
          }),
          type: ProfileActivityLogType.DROP_CREATED,
          proxy_id: model.proxy_id ?? null
        },
        connection,
        timer
      ),
      this.insertMentionsInDrop({ model, wave }, { timer, connection }),
      this.dropsDb.insertReferencedNfts(
        Object.values(
          model.referenced_nfts.reduce<Record<string, DropReferencedNftModel>>(
            (acc, it) => {
              acc[JSON.stringify(it)] = it;
              return acc;
            },
            {} as Record<string, DropReferencedNftModel>
          )
        ).map((it) => ({
          drop_id: dropId,
          contract: it.contract,
          token: it.token,
          name: it.name,
          wave_id: wave.id
        })),
        connection,
        timer
      ),
      this.dropsDb.insertDropMetadata(
        model.metadata.map((it) => ({
          ...it,
          drop_id: dropId,
          wave_id: wave.id
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
                wave_id: wave.id
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
          wave_id: wave.id
        })),
        connection,
        timer
      ),
      this.recordQuoteNotifications({ model, wave }, { timer, connection })
    ]);
    timer.stop(`${CreateOrUpdateDropUseCase.name}->insertAllDropComponents`);
  }

  private async recordQuoteNotifications(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->recordQuoteNotifications`);
    let idx = 1;
    const quoteNotificationDatas: DropQuoteNotificationData[] = [];
    for (const createDropPart of model.parts) {
      const quotedDrop = createDropPart.quoted_drop;
      if (quotedDrop) {
        const quotedEntity = await this.dropsDb
          .getDropsByIds([quotedDrop.drop_id], connection)
          .then((it) => it[0]);
        quoteNotificationDatas.push({
          quote_drop_id: model.drop_id!,
          quote_drop_part: idx,
          quote_drop_author_id: quotedEntity.author_id,
          quoted_drop_id: quotedDrop.drop_id,
          quoted_drop_part: quotedDrop.drop_part_id,
          quoted_drop_author_id: quotedEntity.author_id,
          wave_id: model.wave_id
        });
      }
      idx++;
    }
    await Promise.all(
      quoteNotificationDatas.map((it) =>
        this.userNotifier.notifyOfDropQuote(
          it,
          wave.visibility_group_id,
          connection,
          timer
        )
      )
    );
    timer.stop(`${CreateOrUpdateDropUseCase.name}->recordQuoteNotifications`);
  }

  private async createDropReplyNotifications(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    const replyTo = model.reply_to;
    if (replyTo) {
      timer.start(`${CreateOrUpdateDropUseCase.name}->getReplyDropEntity`);
      const replyToEntity = await this.dropsDb
        .getDropsByIds([replyTo.drop_id], connection)
        .then((r) => r[0]);
      timer.stop(`${CreateOrUpdateDropUseCase.name}->getReplyDropEntity`);
      timer.start(`${CreateOrUpdateDropUseCase.name}->notifyOfDropReply`);
      await this.userNotifier.notifyOfDropReply(
        {
          reply_drop_id: model.drop_id!,
          reply_drop_author_id: model.author_id!,
          replied_drop_id: replyTo.drop_id,
          replied_drop_part: replyTo.drop_part_id,
          replied_drop_author_id: replyToEntity.author_id,
          wave_id: wave.id
        },
        wave.visibility_group_id,
        connection,
        timer
      );
      timer.stop(`${CreateOrUpdateDropUseCase.name}->notifyOfDropReply`);
    }
  }

  private async insertMentionsInDrop(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { connection: ConnectionWrapper<any>; timer: Timer }
  ) {
    timer.start(`${CreateOrUpdateDropUseCase.name}->insertMentionsInDrop`);
    const mentionedHandles = model.mentioned_users.map((it) => it.handle);
    const mentionedHandledWithIds = Object.entries(
      await this.profilesDb.getIdsByHandles(mentionedHandles, connection)
    );
    const dropId = model.drop_id!;
    const waveId = model.wave_id;
    const mentionEntities = mentionedHandledWithIds.map<
      Omit<DropMentionEntity, 'id'>
    >(([handle, id]) => ({
      drop_id: dropId,
      mentioned_profile_id: id,
      handle_in_content: handle,
      wave_id: waveId
    }));
    await Promise.all([
      ...mentionEntities.map((mentionEntity) =>
        this.userNotifier.notifyOfIdentityMention(
          {
            mentioned_identity_id: mentionEntity.mentioned_profile_id,
            drop_id: dropId,
            mentioner_identity_id: model.author_identity,
            wave_id: waveId
          },
          wave.visibility_group_id,
          connection,
          timer
        )
      ),
      this.dropsDb.insertMentions(mentionEntities, connection)
    ]);
    timer.stop(`${CreateOrUpdateDropUseCase.name}->insertMentionsInDrop`);
  }

  private async recordDropCreatedActivity(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { connection: ConnectionWrapper<any>; timer: Timer }
  ) {
    const replyTo = model.reply_to;
    await this.activityRecorder.recordDropCreated(
      {
        drop_id: model.drop_id!,
        creator_id: model.author_id!,
        wave_id: model.wave_id,
        visibility_group_id: wave.visibility_group_id,
        reply_to: replyTo
          ? {
              drop_id: replyTo.drop_id,
              part_id: replyTo.drop_part_id
            }
          : null
      },
      connection,
      timer
    );
  }

  private async deleteAllDropComponentsById(
    model: CreateOrUpdateDropModel,
    { timer, connection }: { connection: ConnectionWrapper<any>; timer: Timer }
  ) {
    const id = model.drop_id!;
    const waveId = model.wave_id;
    await Promise.all([
      this.dropsDb.deleteDropParts(id, { timer, connection }),
      this.dropsDb.deleteDropMentions(id, { timer, connection }),
      this.dropsDb.deleteDropMedia(id, { timer, connection }),
      this.dropsDb.deleteDropReferencedNfts(id, { timer, connection }),
      this.dropsDb.deleteDropMetadata(id, { timer, connection }),
      this.dropsDb.deleteDropEntity(id, { timer, connection }),
      this.dropsDb.updateWaveDropCounters(waveId, { timer, connection }),
      dropRaterService.deleteDropVotes(id, { timer, connection }),
      this.dropsDb.deleteDropFeedItems(id, { timer, connection }),
      this.dropsDb.deleteDropNotifications(id, { timer, connection }),
      this.dropsDb.deleteDropSubscriptions(id, { timer, connection })
    ]);
  }
}

export const createOrUpdateDrop = new CreateOrUpdateDropUseCase(
  dropsDb,
  userGroupsService,
  profilesService,
  profilesDb,
  wavesApiDb,
  userNotifier,
  activityRecorder,
  identitySubscriptionsDb,
  profileActivityLogsDb,
  profileProxyApiService
);