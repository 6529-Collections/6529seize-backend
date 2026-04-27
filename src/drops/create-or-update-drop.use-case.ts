import {
  CreateOrUpdateDropModel,
  DropPartIdentifierModel,
  DropReferencedNftModel
} from './create-or-update-drop.model';
import { Time, Timer } from '@/time';
import { ConnectionWrapper } from '@/sql-executor';
import { dropsDb, DropsDb } from './drops.db';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import {
  ParticipationRequiredMedia,
  WaveEntity,
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveRequiredMetadataItemType,
  WaveSubmissionType,
  WaveType
} from '@/entities/IWave';
import { assertUnreachable } from '@/assertions';
import { randomUUID } from 'crypto';
import {
  DropGroupMentionEntity,
  DropMediaEntity,
  DropMentionedWaveEntity,
  DropMentionEntity,
  DropPartEntity,
  DropType
} from '@/entities/IDrop';
import { AttachmentStatus, DropAttachmentEntity } from '@/entities/IAttachment';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { DropQuoteNotificationData } from '@/notifications/user-notification.types';
import { userNotifier, UserNotifier } from '@/notifications/user.notifier';
import {
  activityRecorder,
  ActivityRecorder
} from '@/activity/activity.recorder';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import {
  profileProxyApiService,
  ProfileProxyApiService
} from '@/api/proxies/proxy.api.service';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import process from 'node:process';
import { deleteDrop, DeleteDropUseCase } from './delete-drop.use-case';
import { dropVotingDb, DropVotingDb } from '@/api/drops/drop-voting.db';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { identitiesDb } from '@/identities/identities.db';
import { numbers } from '@/numbers';
import { collections } from '@/collections';
import { metricsRecorder, MetricsRecorder } from '@/metrics/MetricsRecorder';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import {
  dropNftLinksDb,
  DropNftLinkInsertModel,
  DropNftLinksDb
} from '@/drops/drop-nft-links.db';
import {
  artCurationTokenWatchService,
  ArtCurationTokenWatchService
} from '@/art-curation/art-curation-token-watch.service';
import { extractUrlCandidatesFromText } from '@/nft-links/nft-link-candidates';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { env } from '@/env';
import { CLOUDFRONT_LINK, UUID_REGEX, WALLET_REGEX } from '@/constants';
import { getAlchemyInstance } from '@/alchemy';
import { profilesService } from '@/profiles/profiles.service';
import { isApproveWaveClosed } from '@/waves/wave-approve.helpers';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';

const ARWEAVE_ORIGIN = 'https://arweave.net';

function isActiveIdentityNomination(nomination: { has_won: boolean }): boolean {
  return !nomination.has_won;
}

function parseDropMediaUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new BadRequestException(`Invalid media url ${url}`);
  }
}

export function validateDropMediaAttachment({
  mimeType,
  url,
  dropType
}: {
  mimeType: string;
  url: string;
  dropType: DropType;
}): void {
  const parsedUrl = parseDropMediaUrl(url);

  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('audio/')
  ) {
    if (parsedUrl.origin !== CLOUDFRONT_LINK) {
      throw new BadRequestException(
        `Media needs to come from ${CLOUDFRONT_LINK}`
      );
    }
    return;
  }

  if (mimeType === 'text/html') {
    if (parsedUrl.origin !== ARWEAVE_ORIGIN && parsedUrl.protocol !== 'ipfs:') {
      throw new BadRequestException(
        `text/html needs to be served from IPFS or Arweave`
      );
    }
    return;
  }

  throw new BadRequestException(`Unsupported mime type ${mimeType}`);
}

type PreResolvedEnsIdentityNomination = Readonly<{
  normalizedEnsName: string;
  normalizedWallet: string;
}>;

type ResolvedMentionedUsers = Readonly<{
  mentionEntities: Omit<DropMentionEntity, 'id'>[];
  mentionedUserIds: string[];
}>;

export class CreateOrUpdateDropUseCase {
  public constructor(
    private readonly dropsDb: DropsDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userNotifier: UserNotifier,
    private readonly activityRecorder: ActivityRecorder,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly proxyService: ProfileProxyApiService,
    private readonly deleteDropUseCase: DeleteDropUseCase,
    private readonly metricsRecorder: MetricsRecorder,
    private readonly dropNftLinksDb: DropNftLinksDb,
    private readonly artCurationTokenWatchService: ArtCurationTokenWatchService,
    private readonly attachmentsDb: AttachmentsDb
  ) {}

  private getRequiredAuthorId(model: CreateOrUpdateDropModel): string {
    const authorId = model.author_id;
    if (!authorId) {
      throw new BadRequestException(`author_id is required`);
    }
    return authorId;
  }

  private getRequiredDropId(model: CreateOrUpdateDropModel): string {
    const dropId = model.drop_id;
    if (!dropId) {
      throw new BadRequestException(`drop_id is required`);
    }
    return dropId;
  }

  private getAllDropsNotificationsSubscribersLimit(): number {
    return env.getIntOrNull('ALL_DROPS_NOTIFICATIONS_SUBSCRIBERS_LIMIT') ?? 15;
  }

  public async execute(
    model: CreateOrUpdateDropModel,
    isDescriptionDrop: boolean,
    {
      timer,
      connection,
      preResolvedIdentityNomination
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    }
  ): Promise<{ drop_id: string; pending_push_notification_ids: number[] }> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->execute`);
    const authorId = model.author_id;
    const proxyIdNecessary = !!model.proxy_identity && !model.proxy_id;
    if (!authorId) {
      const authorIdentity = model.author_identity;
      const resolvedAuthorId =
        await identityFetcher.getProfileIdByIdentityKeyOrThrow(
          {
            identityKey: authorIdentity
          },
          {}
        );
      return this.execute(
        { ...model, author_id: resolvedAuthorId },
        isDescriptionDrop,
        { timer, connection, preResolvedIdentityNomination }
      );
    } else if (proxyIdNecessary) {
      const proxyIdentity = model.proxy_identity;
      const resolvedProxyId =
        await identityFetcher.getProfileIdByIdentityKeyOrThrow(
          {
            identityKey: proxyIdentity
          },
          {}
        );
      const hasRequiredProxyAction =
        await this.proxyService.hasActiveProxyAction({
          granted_by_profile_id: authorId,
          granted_to_profile_id: resolvedProxyId,
          action: ProfileProxyActionType.CREATE_DROP_TO_WAVE
        });
      if (!hasRequiredProxyAction) {
        throw new BadRequestException(
          `Identity ${model.author_identity} hasn't allowed identity ${model.proxy_identity} to create drops on it's behalf`
        );
      }
      return this.execute(
        { ...model, proxy_id: resolvedProxyId },
        isDescriptionDrop,
        { timer, connection, preResolvedIdentityNomination }
      );
    }
    return await this.createOrUpdateDrop(model, isDescriptionDrop, {
      timer,
      connection,
      preResolvedIdentityNomination
    });
  }

  public async preResolveIdentityNomination(
    model: CreateOrUpdateDropModel,
    { timer }: { timer?: Timer }
  ): Promise<PreResolvedEnsIdentityNomination | null> {
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->preResolveIdentityNomination`
    );
    try {
      if (model.drop_type !== DropType.PARTICIPATORY) {
        return null;
      }

      const identityMetadatas = model.metadata.filter(
        (it) => it.data_key === 'identity'
      );
      if (identityMetadatas.length !== 1) {
        return null;
      }

      const nominationInput = identityMetadatas[0]!.data_value.trim();
      if (!nominationInput.length) {
        return null;
      }

      const normalizedInput = nominationInput.toLowerCase();
      if (!normalizedInput.endsWith('.eth')) {
        return null;
      }

      const resolvedWallet =
        await getAlchemyInstance().core.resolveName(normalizedInput);
      if (!resolvedWallet) {
        throw new BadRequestException(
          `ENS name ${nominationInput} could not be resolved`
        );
      }

      const normalizedWallet = resolvedWallet.toLowerCase();
      if (!WALLET_REGEX.exec(normalizedWallet)) {
        throw new BadRequestException(
          `ENS name ${nominationInput} resolved to invalid wallet ${resolvedWallet}`
        );
      }

      return {
        normalizedEnsName: normalizedInput,
        normalizedWallet
      };
    } finally {
      timer?.stop(
        `${CreateOrUpdateDropUseCase.name}->preResolveIdentityNomination`
      );
    }
  }

  private async createOrUpdateDrop(
    model: CreateOrUpdateDropModel,
    isDescriptionDrop: boolean,
    {
      timer,
      connection,
      preResolvedIdentityNomination
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    }
  ): Promise<{ drop_id: string; pending_push_notification_ids: number[] }> {
    if (model.drop_type === DropType.WINNER) {
      throw new BadRequestException(`Can't modify a winner drop`);
    }
    const validatedModel = await this.validateReferences(
      model,
      isDescriptionDrop,
      {
        timer,
        connection,
        preResolvedIdentityNomination
      }
    );
    const authorId = this.getRequiredAuthorId(validatedModel);
    const preExistingDropId = validatedModel.drop_id;
    const wave = await this.wavesApiDb.findById(
      validatedModel.wave_id,
      connection
    );
    if (!wave) {
      throw new BadRequestException(`Wave ${validatedModel.wave_id} not found`);
    }
    if (
      wave.type === WaveType.CHAT &&
      validatedModel.drop_type !== DropType.CHAT
    ) {
      throw new BadRequestException('Chat waves only allow chat drops');
    }
    let dropId: string;
    let pendingPushNotificationIds: number[] = [];
    if (preExistingDropId) {
      dropId = preExistingDropId;
      const [dropBeforeUpdate, existingMentionedGroups] = await Promise.all([
        this.dropsDb.findDropById(dropId, connection),
        this.dropsDb.getDropGroupMentions(dropId, connection)
      ]);
      if (dropBeforeUpdate === null) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }
      if (dropBeforeUpdate.wave_id !== validatedModel.wave_id) {
        throw new BadRequestException("Can't change wave of a drop");
      }
      if (dropBeforeUpdate.drop_type !== validatedModel.drop_type) {
        throw new BadRequestException("Can't change type of a drop");
      }
      if (dropBeforeUpdate.author_id !== authorId) {
        throw new ForbiddenException(
          "Only author can change it's drop. You are not the author of this drop"
        );
      }
      const dropLastTouched = Time.millis(
        dropBeforeUpdate.updated_at ?? dropBeforeUpdate.created_at
      );
      const maximumTimeAllowedForEdit = Time.millis(
        numbers.parseIntOrNull(process.env.MAX_DROP_EDIT_TIME_MS) ?? 0
      );
      if (dropLastTouched.diffFromNow().gt(maximumTimeAllowedForEdit)) {
        throw new ForbiddenException(
          `Drop can't be edited after ${maximumTimeAllowedForEdit}`
        );
      }
      await this.deleteDropUseCase.execute(
        {
          drop_id: dropId,
          deleter_identity: validatedModel.author_identity,
          deleter_id: authorId,
          deletion_purpose: 'UPDATE'
        },
        { timer, connection }
      );
      pendingPushNotificationIds = await this.insertAllDropComponents(
        {
          model: {
            ...validatedModel,
            drop_id: dropId,
            mentioned_groups: existingMentionedGroups
          },
          createdAt: dropBeforeUpdate.created_at,
          serialNo: dropBeforeUpdate.serial_no,
          updatedAt: Time.currentMillis(),
          wave
        },
        { connection, timer }
      );
    } else {
      dropId = randomUUID();
      pendingPushNotificationIds = await this.insertAllDropComponents(
        {
          model: { ...validatedModel, drop_id: dropId },
          createdAt: Time.currentMillis(),
          serialNo: null,
          updatedAt: null,
          wave
        },
        { connection, timer }
      );
      await Promise.all([
        this.metricsRecorder.recordDrop(
          {
            identityId: authorId,
            waveId: validatedModel.wave_id,
            dropType: validatedModel.drop_type
          },
          { timer, connection }
        ),
        this.metricsRecorder.recordActiveIdentity(
          { identityId: authorId },
          { timer, connection }
        )
      ]);
    }
    await this.artCurationTokenWatchService.registerDrop(
      {
        dropId,
        waveId: validatedModel.wave_id,
        dropType: validatedModel.drop_type,
        links: this.buildDropNftLinks(validatedModel)
      },
      { timer, connection }
    );
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->execute`);
    return {
      drop_id: dropId,
      pending_push_notification_ids: pendingPushNotificationIds
    };
  }

  private async validateReferences(
    model: CreateOrUpdateDropModel,
    isDescriptionDrop: boolean,
    {
      timer,
      connection,
      preResolvedIdentityNomination
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    }
  ): Promise<CreateOrUpdateDropModel> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->validateReferences`);
    const authorId = this.getRequiredAuthorId(model);
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(authorId, timer);

    const [validatedModel] = await Promise.all([
      this.verifyWaveLimitations(
        {
          model,
          groupIdsUserIsEligibleFor,
          isDescriptionDrop,
          preResolvedIdentityNomination
        },
        { timer, connection }
      ),
      this.verifyMentionedWaves(
        { model, groupIdsUserIsEligibleFor },
        { timer, connection }
      ),
      this.verifyQuotedDrops(model, { timer, connection }),
      this.verifyReplyDrop(model, { timer, connection })
    ]);
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->validateReferences`);
    return validatedModel;
  }

  private async verifyWaveLimitations(
    {
      isDescriptionDrop,
      model,
      groupIdsUserIsEligibleFor,
      preResolvedIdentityNomination
    }: {
      isDescriptionDrop: boolean;
      model: CreateOrUpdateDropModel;
      groupIdsUserIsEligibleFor: string[];
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<CreateOrUpdateDropModel> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyWaveLimitations`);
    const waveId = model.wave_id;
    const wave = await this.wavesApiDb.findById(waveId, connection);
    if (!wave) {
      throw new BadRequestException(`Wave ${waveId} not found`);
    }
    const groupId =
      model.drop_type === DropType.PARTICIPATORY
        ? wave.participation_group_id
        : wave.chat_group_id;
    if (
      !isDescriptionDrop &&
      groupId &&
      !groupIdsUserIsEligibleFor.includes(groupId)
    ) {
      throw new ForbiddenException(`User is not eligible for this wave`);
    }
    this.verifyGroupMentions({
      model,
      wave,
      groupIdsUserIsEligibleFor
    });
    await Promise.all([
      this.verifyParticipatoryLimitations(
        {
          isDescriptionDrop,
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
      )
    ]);
    const validatedModel = await this.verifyMetadata(
      {
        wave,
        model,
        preResolvedIdentityNomination
      },
      { timer, connection }
    );
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyWaveLimitations`);
    return validatedModel;
  }

  private async verifyMetadata(
    {
      wave,
      model,
      preResolvedIdentityNomination
    }: {
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<CreateOrUpdateDropModel> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyMetadata`);
    if (model.drop_type === DropType.PARTICIPATORY) {
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
          if (
            !metadata.some(
              (it) => numbers.parseIntOrNull(it.data_value) !== null
            )
          ) {
            throw new BadRequestException(
              `Wave requires metadata ${requiredMetadata.name} to be a number`
            );
          }
        }
      }
      if (wave.submission_type === WaveSubmissionType.IDENTITY) {
        await this.verifyIdentitySubmissionMetadata(
          { wave, model, preResolvedIdentityNomination },
          { timer, connection }
        );
      }
    }
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyMetadata`);
    return model;
  }

  private async verifyParticipatoryLimitations(
    {
      isDescriptionDrop,
      wave,
      model
    }: {
      isDescriptionDrop: boolean;
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->verifyParticipatoryLimitations`
    );
    if (
      wave.type === WaveType.CHAT &&
      model.drop_type === DropType.PARTICIPATORY
    ) {
      throw new ForbiddenException(
        `Participatory drops are not allowed in chat waves`
      );
    }
    const now = Time.now();
    if (model.drop_type === DropType.PARTICIPATORY) {
      if (wave.type === WaveType.APPROVE && wave.max_winners != null) {
        const noOfDecisionsDone = await this.wavesApiDb
          .countWaveDecisionsByWaveIds([wave.id], { timer, connection })
          .then((it) => it[wave.id] ?? 0);
        if (
          isApproveWaveClosed({
            waveType: wave.type,
            maxWinners: wave.max_winners,
            decisionsDone: noOfDecisionsDone
          })
        ) {
          throw new ForbiddenException(`Participation to this wave is closed`);
        }
      }
      const participationPeriodStart = Time.millis(
        wave.participation_period_start ?? 0
      );
      const participationPeriodEnd = Time.millis(
        wave.participation_period_end ?? Time.now().plusWeeks(1).toMillis()
      );
      if (
        (!isDescriptionDrop && now.lt(participationPeriodStart)) ||
        now.gt(participationPeriodEnd)
      ) {
        throw new ForbiddenException(
          `Participation to this wave is locked for now`
        );
      }
    }
    if (
      !isDescriptionDrop &&
      !wave.chat_enabled &&
      model.drop_type === DropType.CHAT
    ) {
      throw new ForbiddenException(`Chat drops are not allowed in this wave`);
    }
    const noOfApplicationsAllowedPerParticipantInWave =
      wave.participation_max_applications_per_participant;
    if (
      model.drop_type === DropType.PARTICIPATORY &&
      noOfApplicationsAllowedPerParticipantInWave !== null &&
      model.drop_id === null
    ) {
      const countOfDropsByAuthorInWave = await this.wavesApiDb
        .findIdentityParticipationDropsCountByWaveId(
          {
            identityId: model.author_identity,
            waveIds: [model.wave_id]
          },
          { timer, connection }
        )
        .then((it) => it[model.wave_id] ?? 0);
      timer?.stop(
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
      if (model.signature === null && wave.participation_signature_required) {
        throw new ForbiddenException(
          `Wave doesn't allow unsigned participatory drops`
        );
      }
    } else {
      timer?.stop(
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
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyMedia`);
    for (const part of model.parts) {
      for (const media of part.media) {
        validateDropMediaAttachment({
          mimeType: media.mime_type,
          url: media.url,
          dropType: model.drop_type
        });
      }
    }
    await this.verifyAttachments({ model }, { timer, connection });
    const requiredMedias = wave.participation_required_media;
    if (model.drop_type === DropType.PARTICIPATORY && requiredMedias.length) {
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
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyMedia`);
  }

  private async verifyAttachments(
    { model }: { model: CreateOrUpdateDropModel },
    {
      timer,
      connection
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
    }
  ) {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyAttachments`);
    try {
      const attachmentIds = model.parts
        .flatMap((part) => part.attachments ?? [])
        .map((attachment) => attachment.attachment_id);
      if (!attachmentIds.length) {
        return;
      }
      const authorId = this.getRequiredAuthorId(model);
      const attachments = await this.attachmentsDb.findAttachmentsByIds(
        attachmentIds,
        connection
      );
      for (const attachmentId of attachmentIds) {
        const attachment = attachments[attachmentId];
        if (!attachment) {
          throw new BadRequestException(`Attachment ${attachmentId} not found`);
        }
        if (attachment.owner_profile_id !== authorId) {
          throw new ForbiddenException(
            `Attachment ${attachmentId} does not belong to the uploader`
          );
        }
        if (
          ![
            AttachmentStatus.UPLOADING,
            AttachmentStatus.VERIFYING,
            AttachmentStatus.PROCESSING,
            AttachmentStatus.READY
          ].includes(attachment.status)
        ) {
          throw new BadRequestException(
            `Attachment ${attachmentId} is not usable`
          );
        }
      }
    } finally {
      timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyAttachments`);
    }
  }

  private async verifyIdentitySubmissionMetadata(
    {
      wave,
      model,
      preResolvedIdentityNomination
    }: {
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<void> {
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->verifyIdentitySubmissionMetadata`
    );
    const identityMetadatas = model.metadata.filter(
      (it) => it.data_key === 'identity'
    );
    if (identityMetadatas.length !== 1) {
      throw new BadRequestException(
        `Identity submission waves require exactly one identity metadata entry`
      );
    }

    const identityMetadata = identityMetadatas[0];
    const nominationInput = identityMetadata.data_value.trim();
    if (!nominationInput.length) {
      throw new BadRequestException(
        `Identity submission waves require a non-empty identity nomination`
      );
    }

    if (
      wave.identity_submission_strategy === null ||
      wave.identity_submission_duplicates === null
    ) {
      throw new BadRequestException(
        `Wave identity submission strategy is misconfigured`
      );
    }

    const nominatedProfileId = await this.resolveIdentityNominationProfileId(
      nominationInput,
      {
        timer,
        connection,
        preResolvedIdentityNomination
      }
    );
    this.verifyIdentitySubmissionWhoCanBeSubmitted({
      submittingProfileId: this.getRequiredAuthorId(model),
      nominatedProfileId,
      strategy: wave.identity_submission_strategy
    });
    await this.verifyIdentitySubmissionDuplicates(
      {
        nominatedProfileId,
        waveId: wave.id,
        duplicatesPolicy: wave.identity_submission_duplicates,
        currentDropId: model.drop_id
      },
      { timer, connection }
    );

    const identityMetadataIndex = model.metadata.findIndex(
      (it) => it.data_key === 'identity'
    );
    model.metadata[identityMetadataIndex] = {
      data_key: 'identity',
      data_value: nominatedProfileId
    };
    timer?.stop(
      `${CreateOrUpdateDropUseCase.name}->verifyIdentitySubmissionMetadata`
    );
  }

  private async resolveIdentityNominationProfileId(
    identityInput: string,
    {
      timer,
      connection,
      preResolvedIdentityNomination
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
    }
  ): Promise<string> {
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->resolveIdentityNominationProfileId`
    );
    const normalizedInput = identityInput.trim();
    const lowercasedInput = normalizedInput.toLowerCase();

    if (WALLET_REGEX.exec(lowercasedInput)) {
      const createdProfiles =
        await profilesService.makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
          [lowercasedInput],
          { timer, connection }
        );
      timer?.stop(
        `${CreateOrUpdateDropUseCase.name}->resolveIdentityNominationProfileId`
      );
      return createdProfiles[lowercasedInput];
    }

    if (lowercasedInput.endsWith('.eth')) {
      if (
        !preResolvedIdentityNomination ||
        preResolvedIdentityNomination.normalizedEnsName !== lowercasedInput
      ) {
        throw new BadRequestException(
          `ENS nomination ${normalizedInput} must be pre-resolved before transactional execution`
        );
      }
      const normalizedWallet = preResolvedIdentityNomination.normalizedWallet;
      await identitiesDb.updateWalletsEnsName(
        {
          wallet: normalizedWallet,
          ensName: preResolvedIdentityNomination.normalizedEnsName
        },
        connection
      );
      const createdProfiles =
        await profilesService.makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
          [normalizedWallet],
          { timer, connection }
        );
      timer?.stop(
        `${CreateOrUpdateDropUseCase.name}->resolveIdentityNominationProfileId`
      );
      return createdProfiles[normalizedWallet];
    }

    const resolvedProfileId = await identityFetcher.getProfileIdByIdentityKey(
      {
        identityKey: UUID_REGEX.exec(normalizedInput)
          ? normalizedInput
          : lowercasedInput
      },
      { timer, connection }
    );
    timer?.stop(
      `${CreateOrUpdateDropUseCase.name}->resolveIdentityNominationProfileId`
    );
    if (!resolvedProfileId) {
      throw new BadRequestException(
        `Identity nomination ${normalizedInput} could not be resolved to a profile`
      );
    }
    return resolvedProfileId;
  }

  private verifyIdentitySubmissionWhoCanBeSubmitted({
    submittingProfileId,
    nominatedProfileId,
    strategy
  }: {
    submittingProfileId: string;
    nominatedProfileId: string;
    strategy: WaveIdentitySubmissionStrategy;
  }): void {
    switch (strategy) {
      case WaveIdentitySubmissionStrategy.ONLY_MYSELF:
        if (submittingProfileId !== nominatedProfileId) {
          throw new ForbiddenException(
            `This wave only allows nominating yourself`
          );
        }
        return;
      case WaveIdentitySubmissionStrategy.ONLY_OTHERS:
        if (submittingProfileId === nominatedProfileId) {
          throw new ForbiddenException(
            `This wave does not allow nominating yourself`
          );
        }
        return;
      case WaveIdentitySubmissionStrategy.EVERYONE:
        return;
      default:
        assertUnreachable(strategy);
    }
  }

  private async verifyIdentitySubmissionDuplicates(
    {
      nominatedProfileId,
      waveId,
      duplicatesPolicy,
      currentDropId
    }: {
      nominatedProfileId: string;
      waveId: string;
      duplicatesPolicy: WaveIdentitySubmissionDuplicates;
      currentDropId: string | null;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<void> {
    if (duplicatesPolicy === WaveIdentitySubmissionDuplicates.ALWAYS_ALLOW) {
      return;
    }

    const existingNominations =
      await this.dropsDb.findIdentityNominationDropsForWave(
        {
          waveId,
          profileId: nominatedProfileId,
          excludeDropId: currentDropId
        },
        { timer, connection }
      );
    if (!existingNominations.length) {
      return;
    }

    switch (duplicatesPolicy) {
      case WaveIdentitySubmissionDuplicates.ALLOW_AFTER_WIN:
        if (existingNominations.some(isActiveIdentityNomination)) {
          throw new BadRequestException(
            `This identity already has an active nomination in the wave`
          );
        }
        return;
      case WaveIdentitySubmissionDuplicates.NEVER_ALLOW:
        throw new BadRequestException(
          `This identity has already been nominated in the wave`
        );
      default:
        assertUnreachable(duplicatesPolicy);
    }
  }

  private async verifyQuotedDrops(
    model: CreateOrUpdateDropModel,
    {
      timer
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
    }
  ) {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyQuotedDrops`);
    const quotedDrops = model.parts
      .map<DropPartIdentifierModel | null | undefined>((it) => it.quoted_drop)
      .filter(
        (it) => it !== undefined && it !== null
      ) as DropPartIdentifierModel[];
    if (quotedDrops.length) {
      if (model.drop_type === DropType.PARTICIPATORY) {
        throw new BadRequestException(
          `Participatory drops can't be quote drops`
        );
      }
      if (model.drop_type === DropType.CHAT) {
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
    }
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyQuotedDrops`);
  }

  private async verifyReplyDrop(
    model: CreateOrUpdateDropModel,
    {
      timer
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
    }
  ) {
    const replyTo = model.reply_to;
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyReplyDrop`);
    if (replyTo) {
      if (model.drop_type === DropType.PARTICIPATORY) {
        throw new BadRequestException(
          `Participatory drops can't be reply drops`
        );
      }
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
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyReplyDrop`);
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
    { connection, timer }: { connection: ConnectionWrapper<any>; timer?: Timer }
  ): Promise<number[]> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->insertAllDropComponents`);
    const dropId = this.getRequiredDropId(model);
    const authorId = this.getRequiredAuthorId(model);
    const parts = model.parts;
    const dropNftLinks = this.buildDropNftLinks(model);
    const resolvedMentionedUsers = await this.resolveMentionedUsers(
      model,
      connection
    );
    if (model.drop_type === DropType.PARTICIPATORY) {
      if (
        wave &&
        wave.next_decision_time !== null &&
        wave.next_decision_time < Time.currentMillis()
      ) {
        throw new ForbiddenException(
          `Wave has unresolved decisions and doesn't accept new drops or drop updates at the moment. Try again later`
        );
      }
    }
    if (model.drop_type === DropType.WINNER) {
      throw new ForbiddenException(
        `Drops which have already won a prize can not be edited`
      );
    }
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
          drop_type: model.drop_type,
          signature: model.signature
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
          wave_id: wave.id,
          subscribed_to_all_drops: false
        },
        connection,
        timer
      ),
      this.recordDropCreatedActivity({ model, wave }, { timer, connection }),
      profileActivityLogsDb.insert(
        {
          profile_id: authorId,
          target_id: dropId.toString(),
          contents: JSON.stringify({
            drop_id: dropId,
            proxy_id: model.proxy_id
          }),
          type: ProfileActivityLogType.DROP_CREATED,
          proxy_id: model.proxy_id ?? null,
          additional_data_1: model.drop_type,
          additional_data_2: wave.id
        },
        connection,
        timer
      ),
      this.insertMentionsInDrop(resolvedMentionedUsers.mentionEntities, {
        timer,
        connection
      }),
      this.dropsDb.insertMentionedWaves(
        model.mentioned_waves?.map<Omit<DropMentionedWaveEntity, 'id'>>(
          (mentionedWave) => ({
            drop_id: dropId,
            wave_id: mentionedWave.wave_id,
            wave_name_in_content: mentionedWave.wave_name_in_content
          })
        ),
        { connection, timer }
      ),
      this.dropsDb.insertDropGroupMentions(
        model.mentioned_groups.map<DropGroupMentionEntity>(
          (mentionedGroup) => ({
            drop_id: dropId,
            mentioned_group: mentionedGroup
          })
        ),
        { connection, timer }
      ),
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
      this.dropVotingDb.upsertWaveLeaderboardEntry(
        {
          drop_id: dropId,
          wave_id: wave.id,
          vote: 0,
          vote_on_decision_time: 0,
          timestamp: createdAt
        },
        { connection, timer }
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
      this.attachmentsDb.insertDropAttachments(
        parts.flatMap(
          (part, index) =>
            part.attachments?.map<DropAttachmentEntity>((attachment) => ({
              drop_id: dropId,
              drop_part_id: index + 1,
              attachment_id: attachment.attachment_id,
              wave_id: wave.id
            })) ?? []
        ),
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
      this.dropNftLinksDb.replaceDropLinks(
        {
          dropId,
          links: dropNftLinks,
          createdAt: Time.currentMillis()
        },
        { connection, timer }
      ),
      this.dropVotingDb.saveDropRealVoteInTime(
        {
          drop_id: dropId,
          wave_id: wave.id,
          timestamp: createdAt,
          vote: 0
        },
        { timer, connection }
      )
    ]);
    await this.recordQuoteNotifications({ model, wave }, { timer, connection });
    const pendingPushNotificationIds = await this.notifyWaveDropRecipients(
      {
        model,
        wave,
        directlyMentionedIdentityIds: resolvedMentionedUsers.mentionedUserIds
      },
      { timer, connection }
    );
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->insertAllDropComponents`);
    return pendingPushNotificationIds;
  }

  private buildDropNftLinks(
    model: CreateOrUpdateDropModel
  ): DropNftLinkInsertModel[] {
    const maxCandidates =
      env.getIntOrNull('MAX_NFT_LINK_CANDIDATES_PER_DROP') ?? 30;
    const deduplicated = new Map<string, DropNftLinkInsertModel>();
    let remaining = maxCandidates;
    for (const part of model.parts) {
      if (remaining <= 0) {
        break;
      }
      const candidates = extractUrlCandidatesFromText(part.content, remaining);
      for (const candidate of candidates) {
        try {
          const canonical = validateLinkUrl(candidate);
          const key = `${candidate}|${canonical.canonicalId}`;
          deduplicated.set(key, {
            url_in_text: candidate,
            canonical_id: canonical.canonicalId
          });
          if (deduplicated.size >= maxCandidates) {
            return Array.from(deduplicated.values());
          }
        } catch (e) {
          // Non-blocking by design: unsupported or malformed links are ignored.
        }
      }
      remaining = maxCandidates - deduplicated.size;
    }
    return Array.from(deduplicated.values());
  }

  private async verifyMentionedWaves(
    {
      model,
      groupIdsUserIsEligibleFor
    }: {
      model: CreateOrUpdateDropModel;
      groupIdsUserIsEligibleFor: string[];
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->verifyMentionedWaves`);
    const mentionedWaveIds = collections.distinct(
      model.mentioned_waves.map((mentionedWave) => mentionedWave.wave_id)
    );
    if (!mentionedWaveIds.length) {
      timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyMentionedWaves`);
      return;
    }
    const eligibleMentionedWaves =
      await this.wavesApiDb.findWavesByIdsEligibleForRead(
        mentionedWaveIds,
        groupIdsUserIsEligibleFor,
        connection
      );
    if (eligibleMentionedWaves.length !== mentionedWaveIds.length) {
      throw new NotFoundException('Wave not found');
    }
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->verifyMentionedWaves`);
  }

  private verifyGroupMentions({
    model,
    wave,
    groupIdsUserIsEligibleFor
  }: {
    model: CreateOrUpdateDropModel;
    wave: WaveEntity;
    groupIdsUserIsEligibleFor: string[];
  }) {
    if (!model.mentioned_groups.length) {
      return;
    }
    if (model.drop_id !== null) {
      throw new BadRequestException(
        `Group mentions can only be used when creating a drop`
      );
    }
    const isCreator = wave.created_by === this.getRequiredAuthorId(model);
    const isAdmin =
      wave.admin_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(wave.admin_group_id);
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException(
        `Only wave creators or admins can mention groups`
      );
    }
  }

  private async recordQuoteNotifications(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->recordQuoteNotifications`);
    const dropId = this.getRequiredDropId(model);
    const authorId = this.getRequiredAuthorId(model);
    let idx = 1;
    const quoteNotificationDatas: DropQuoteNotificationData[] = [];
    for (const createDropPart of model.parts) {
      const quotedDrop = createDropPart.quoted_drop;
      if (quotedDrop) {
        const quotedEntity = await this.dropsDb
          .getDropsByIds([quotedDrop.drop_id], connection)
          .then((it) => it[0]);
        quoteNotificationDatas.push({
          quote_drop_id: dropId,
          quote_drop_part: idx,
          quote_drop_author_id: authorId,
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
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->recordQuoteNotifications`);
  }

  private async createDropReplyNotifications(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    const replyTo = model.reply_to;
    if (replyTo) {
      const dropId = this.getRequiredDropId(model);
      const authorId = this.getRequiredAuthorId(model);
      timer?.start(`${CreateOrUpdateDropUseCase.name}->getReplyDropEntity`);
      const replyToEntity = await this.dropsDb
        .getDropsByIds([replyTo.drop_id], connection)
        .then((r) => r[0]);
      timer?.stop(`${CreateOrUpdateDropUseCase.name}->getReplyDropEntity`);
      timer?.start(`${CreateOrUpdateDropUseCase.name}->notifyOfDropReply`);
      await this.userNotifier.notifyOfDropReply(
        {
          reply_drop_id: dropId,
          reply_drop_author_id: authorId,
          replied_drop_id: replyTo.drop_id,
          replied_drop_part: replyTo.drop_part_id,
          replied_drop_author_id: replyToEntity.author_id,
          wave_id: wave.id
        },
        wave.visibility_group_id,
        connection,
        timer
      );
      timer?.stop(`${CreateOrUpdateDropUseCase.name}->notifyOfDropReply`);
    }
  }

  private async resolveMentionedUsers(
    model: CreateOrUpdateDropModel,
    connection: ConnectionWrapper<any>
  ): Promise<ResolvedMentionedUsers> {
    const mentionedHandles = model.mentioned_users.map((it) => it.handle);
    const mentionedHandlesWithIds = Object.entries(
      await identitiesDb.getIdsByHandles(mentionedHandles, connection)
    );
    const dropId = this.getRequiredDropId(model);
    const waveId = model.wave_id;
    const mentionEntities = mentionedHandlesWithIds.map<
      Omit<DropMentionEntity, 'id'>
    >(([handle, id]) => ({
      drop_id: dropId,
      mentioned_profile_id: id,
      handle_in_content: handle,
      wave_id: waveId
    }));
    return {
      mentionEntities,
      mentionedUserIds: collections.distinct(
        mentionEntities.map((it) => it.mentioned_profile_id)
      )
    };
  }

  private async insertMentionsInDrop(
    mentionEntities: Omit<DropMentionEntity, 'id'>[],
    { timer, connection }: { connection: ConnectionWrapper<any>; timer?: Timer }
  ) {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->insertMentionsInDrop`);
    await this.dropsDb.insertMentions(mentionEntities, connection);
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->insertMentionsInDrop`);
  }

  private async recordDropCreatedActivity(
    { model, wave }: { model: CreateOrUpdateDropModel; wave: WaveEntity },
    { timer, connection }: { connection: ConnectionWrapper<any>; timer?: Timer }
  ) {
    const replyTo = model.reply_to;
    const dropId = this.getRequiredDropId(model);
    const authorId = this.getRequiredAuthorId(model);
    await this.activityRecorder.recordDropCreated(
      {
        drop_id: dropId,
        creator_id: authorId,
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

  private async notifyWaveDropRecipients(
    {
      model,
      wave,
      directlyMentionedIdentityIds
    }: {
      model: CreateOrUpdateDropModel;
      wave: WaveEntity;
      directlyMentionedIdentityIds: string[];
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<number[]> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->notifyWaveDropRecipients`);
    const dropId = this.getRequiredDropId(model);
    const authorId = this.getRequiredAuthorId(model);
    const [followerRecipients, waveSubscribersCount] = await Promise.all([
      this.identitySubscriptionsDb.findWaveFollowersEligibleForDropNotifications(
        {
          waveId: wave.id,
          authorId,
          mentionedGroups: model.mentioned_groups
        },
        connection
      ),
      this.identitySubscriptionsDb.countWaveSubscribers(wave.id, connection)
    ]);
    const mutedDirectMentionedIdentityIds = new Set(
      await this.identitySubscriptionsDb.findMutedWaveReaders(
        wave.id,
        directlyMentionedIdentityIds,
        connection
      )
    );
    const directMentionIdentityIds = collections.distinct(
      directlyMentionedIdentityIds.filter(
        (identityId) =>
          identityId !== authorId &&
          !mutedDirectMentionedIdentityIds.has(identityId)
      )
    );
    const mentionedIdentityIds = collections.distinct([
      ...directMentionIdentityIds,
      ...followerRecipients
        .filter((recipient) => recipient.has_group_mention)
        .map((recipient) => recipient.identity_id)
    ]);
    const mentionedIdentityIdsSet = new Set(mentionedIdentityIds);
    const allDropsSubscriberIds =
      waveSubscribersCount < this.getAllDropsNotificationsSubscribersLimit()
        ? followerRecipients
            .filter(
              (recipient) =>
                recipient.subscribed_to_all_drops &&
                !mentionedIdentityIdsSet.has(recipient.identity_id)
            )
            .map((recipient) => recipient.identity_id)
        : [];

    const pendingPushNotificationIds =
      await this.userNotifier.notifyWaveDropCreatedRecipients(
        {
          waveId: wave.id,
          dropId,
          relatedIdentityId: authorId,
          mentionedIdentityIds,
          allDropsSubscriberIds
        },
        wave.visibility_group_id,
        { timer, connection }
      );
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->notifyWaveDropRecipients`);
    return pendingPushNotificationIds;
  }
}

export const createOrUpdateDrop = new CreateOrUpdateDropUseCase(
  dropsDb,
  dropVotingDb,
  userGroupsService,
  wavesApiDb,
  userNotifier,
  activityRecorder,
  identitySubscriptionsDb,
  profileProxyApiService,
  deleteDrop,
  metricsRecorder,
  dropNftLinksDb,
  artCurationTokenWatchService,
  attachmentsDb
);
