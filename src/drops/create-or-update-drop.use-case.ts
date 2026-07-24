import {
  CreateOrUpdateDropModel,
  CreateOrUpdateDropPartModel,
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
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
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
import {
  DropQuoteNotificationData,
  DropReplyNotificationData
} from '@/notifications/user-notification.types';
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
  DropNftLinkInsertModel,
  dropNftLinksDb,
  DropNftLinksDb
} from '@/drops/drop-nft-links.db';
import {
  artCurationTokenWatchService,
  ArtCurationTokenWatchService
} from '@/art-curation/art-curation-token-watch.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { extractUrlCandidatesFromText } from '@/nft-links/nft-link-candidates';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { env } from '@/env';
import { CLOUDFRONT_LINK, UUID_REGEX, WALLET_REGEX } from '@/constants';
import { getAlchemyInstance } from '@/alchemy';
import { profilesService } from '@/profiles/profiles.service';
import { isApproveWaveClosed } from '@/waves/wave-approve.helpers';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import {
  dropMediaUploadsDb,
  DropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import {
  isWaveChatSlowModeActive,
  isWaveChatSlowModeExempt
} from '@/waves/wave-chat-slow-mode.helpers';
import { isWaveCreatorOrAdmin } from '@/waves/wave-admin.helpers';
import { parseDecentralizedMediaRef } from '@/decentralized-media/decentralized-media';
import { Logger } from '@/logging';

const TENOR_CHAT_LINK_ORIGIN = 'https://media.tenor.com';
const GIPHY_CHAT_LINK_HOST_REGEX = /^media\d*\.giphy\.com$/;
const ALLOWED_GIF_CHAT_LINK_EXTENSION_REGEX = /\.(?:gif|mp4|jpg|webp)$/i;
const MISSING_DEVELOPER_MENTION_WARNING_INTERVAL_MS = 5 * 60 * 1000;

interface DropRelationshipNotifications {
  readonly replyNotification: DropReplyNotificationData | null;
  readonly quoteNotifications: DropQuoteNotificationData[];
}

const GROUP_MENTION_TOKENS: Readonly<Record<DropGroupMention, string>> = {
  [DropGroupMention.ALL]: 'all',
  [DropGroupMention.CONTRIBUTORS]: 'contributors',
  [DropGroupMention.ADMINS]: 'admins',
  [DropGroupMention.DEVS_6529]: 'devs6529'
};

function createGroupMentionPattern(token: string): RegExp {
  return new RegExp(`(^|[^a-z0-9_@])@${token}(?![a-z0-9_@])`, 'i');
}

const GROUP_MENTION_PATTERNS: Readonly<Record<DropGroupMention, RegExp>> = {
  [DropGroupMention.ALL]: createGroupMentionPattern(
    GROUP_MENTION_TOKENS[DropGroupMention.ALL]
  ),
  [DropGroupMention.CONTRIBUTORS]: createGroupMentionPattern(
    GROUP_MENTION_TOKENS[DropGroupMention.CONTRIBUTORS]
  ),
  [DropGroupMention.ADMINS]: createGroupMentionPattern(
    GROUP_MENTION_TOKENS[DropGroupMention.ADMINS]
  ),
  [DropGroupMention.DEVS_6529]: createGroupMentionPattern(
    GROUP_MENTION_TOKENS[DropGroupMention.DEVS_6529]
  )
};

function hasGroupMentionToken(
  content: string | null,
  mentionedGroup: DropGroupMention
): boolean {
  return GROUP_MENTION_PATTERNS[mentionedGroup].test(content ?? '');
}

export function normalizeDropGroupMentions({
  parts
}: {
  parts: readonly Pick<CreateOrUpdateDropPartModel, 'content'>[];
}): DropGroupMention[] {
  return Object.values(DropGroupMention).filter((mentionedGroup) =>
    parts.some((part) => hasGroupMentionToken(part.content, mentionedGroup))
  );
}

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
    if (!isDecentralizedHtmlMediaUrl(url)) {
      throw new BadRequestException(
        `text/html needs to be served from IPFS, IPNS, or Arweave`
      );
    }
    return;
  }

  throw new BadRequestException(`Unsupported mime type ${mimeType}`);
}

function isDecentralizedHtmlMediaUrl(url: string): boolean {
  const ref = parseDecentralizedMediaRef(url);
  return (
    ref?.protocol === 'ipfs' ||
    ref?.protocol === 'ipns' ||
    ref?.protocol === 'arweave'
  );
}

type PreResolvedEnsIdentityNomination = Readonly<{
  normalizedEnsName: string;
  normalizedWallet: string;
}>;

type ResolvedMentionedUsers = Readonly<{
  mentionEntities: Omit<DropMentionEntity, 'id'>[];
  mentionedUserIds: string[];
}>;

export function sanitizeDropStructuredFields(
  model: CreateOrUpdateDropModel
): CreateOrUpdateDropModel {
  const title = model.title?.trim() ?? null;
  return {
    ...model,
    title: title === '' ? null : title,
    metadata: model.metadata
      .map((metadata) => ({
        ...metadata,
        data_key: metadata.data_key.trim(),
        data_value: metadata.data_value.trim()
      }))
      .filter(
        (metadata) => metadata.data_key !== '' && metadata.data_value !== ''
      )
  };
}

export class CreateOrUpdateDropUseCase {
  // Intentionally throttled per warm Lambda container, not per wave. One
  // warning is enough to surface the shared missing environment configuration.
  private nextMissingDeveloperMentionWarningAt = 0;
  private readonly logger = Logger.get(CreateOrUpdateDropUseCase.name);

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
    private readonly attachmentsDb: AttachmentsDb,
    private readonly dropMediaUploadsDb: DropMediaUploadsDb
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

  private normalizeMentionedGroups(
    model: CreateOrUpdateDropModel
  ): CreateOrUpdateDropModel {
    return {
      ...model,
      // Content is the source of truth on creates and edits. The update path
      // deletes the old rows before insertDropGroupMentions persists this
      // freshly derived set, so removed tokens do not leave stale metadata.
      mentioned_groups: normalizeDropGroupMentions({
        parts: model.parts
      })
    };
  }

  public async execute(
    model: CreateOrUpdateDropModel,
    isDescriptionDrop: boolean,
    {
      timer,
      connection,
      preResolvedIdentityNomination,
      bypassChatLinkRestrictions,
      bypassChatSlowModeRestrictions
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
      bypassChatLinkRestrictions?: boolean;
      bypassChatSlowModeRestrictions?: boolean;
    }
  ): Promise<{ drop_id: string; pending_push_notification_ids: number[] }> {
    let resolvedModel = sanitizeDropStructuredFields(model);
    timer?.start(`${CreateOrUpdateDropUseCase.name}->execute`);
    let authorId = resolvedModel.author_id;
    if (!authorId) {
      const authorIdentity = resolvedModel.author_identity;
      const resolvedAuthorId =
        await identityFetcher.getProfileIdByIdentityKeyOrThrow(
          {
            identityKey: authorIdentity
          },
          {}
        );
      resolvedModel = { ...resolvedModel, author_id: resolvedAuthorId };
      authorId = resolvedAuthorId;
    }
    if (!!resolvedModel.proxy_identity && !resolvedModel.proxy_id) {
      const proxyIdentity = resolvedModel.proxy_identity;
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
          `Identity ${resolvedModel.author_identity} hasn't allowed identity ${resolvedModel.proxy_identity} to create drops on it's behalf`
        );
      }
      resolvedModel = { ...resolvedModel, proxy_id: resolvedProxyId };
    }
    return await this.createOrUpdateDrop(resolvedModel, isDescriptionDrop, {
      timer,
      connection,
      preResolvedIdentityNomination,
      bypassChatLinkRestrictions,
      bypassChatSlowModeRestrictions
    });
  }

  public async preResolveIdentityNomination(
    model: CreateOrUpdateDropModel,
    { timer }: { timer?: Timer }
  ): Promise<PreResolvedEnsIdentityNomination | null> {
    const sanitizedModel = sanitizeDropStructuredFields(model);
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->preResolveIdentityNomination`
    );
    try {
      if (sanitizedModel.drop_type !== DropType.PARTICIPATORY) {
        return null;
      }

      const identityMetadatas = sanitizedModel.metadata.filter(
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
      preResolvedIdentityNomination,
      bypassChatLinkRestrictions,
      bypassChatSlowModeRestrictions
    }: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
      preResolvedIdentityNomination?: PreResolvedEnsIdentityNomination | null;
      bypassChatLinkRestrictions?: boolean;
      bypassChatSlowModeRestrictions?: boolean;
    }
  ): Promise<{ drop_id: string; pending_push_notification_ids: number[] }> {
    if (model.drop_type === DropType.WINNER) {
      throw new BadRequestException(`Can't modify a winner drop`);
    }
    const normalizedModel = this.normalizeMentionedGroups(model);
    const { validatedModel, groupIdsUserIsEligibleFor } =
      await this.validateReferences(normalizedModel, isDescriptionDrop, {
        timer,
        connection,
        preResolvedIdentityNomination
      });
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
    this.verifyChatLinksAreAllowed({
      isDescriptionDrop,
      wave,
      model: validatedModel,
      groupIdsUserIsEligibleFor,
      bypassChatLinkRestrictions
    });
    if (
      !isDescriptionDrop &&
      preExistingDropId === null &&
      validatedModel.drop_type === DropType.CHAT &&
      isWaveChatSlowModeActive(wave)
    ) {
      await this.verifyChatSlowModeLimitations(
        {
          isDescriptionDrop,
          wave,
          model: validatedModel,
          groupIdsUserIsEligibleFor,
          bypassChatSlowModeRestrictions
        },
        { timer, connection }
      );
    }
    let dropId: string;
    let pendingPushNotificationIds: number[] = [];
    if (preExistingDropId) {
      dropId = preExistingDropId;
      const dropBeforeUpdate = await this.dropsDb.findDropById(
        dropId,
        connection
      );
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
        env.getIntOrNull('MAX_DROP_EDIT_TIME_MS') ?? 0
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
            drop_id: dropId
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
      const createdAt = Time.currentMillis();
      pendingPushNotificationIds = await this.insertAllDropComponents(
        {
          model: { ...validatedModel, drop_id: dropId },
          createdAt,
          serialNo: null,
          updatedAt: null,
          wave
        },
        { connection, timer }
      );
      await this.ensureDirectMessageReaderMetricsForNewDrop(
        {
          wave,
          authorId,
          createdAt
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

  private async ensureDirectMessageReaderMetricsForNewDrop(
    {
      wave,
      authorId,
      createdAt
    }: {
      wave: WaveEntity;
      authorId: string;
      createdAt: number;
    },
    { connection, timer }: { connection: ConnectionWrapper<any>; timer?: Timer }
  ) {
    if (wave.is_direct_message !== true) {
      return;
    }
    const directMessageGroupId = wave.chat_group_id;
    if (!directMessageGroupId) {
      return;
    }
    const readerIds = await this.userGroupsService.findIdentitiesInGroups(
      [directMessageGroupId],
      { timer, connection }
    );
    const recipientIds = readerIds.filter((readerId) => readerId !== authorId);
    const existingReaderMetricIds =
      await this.wavesApiDb.findExistingWaveReaderMetricReaderIds(
        {
          waveId: wave.id,
          readerIds: recipientIds
        },
        { timer, connection }
      );
    const existingReaderMetricIdSet = new Set(existingReaderMetricIds);
    const missingReaderMetricIds = recipientIds.filter(
      (readerId) => !existingReaderMetricIdSet.has(readerId)
    );
    if (!missingReaderMetricIds.length) {
      return;
    }
    // Reader metrics are part of DM write consistency: without this row the
    // unread summary cannot distinguish current unread activity from old history.
    await this.wavesApiDb.insertMissingWaveReaderMetrics(
      {
        waveId: wave.id,
        readerIds: missingReaderMetricIds,
        latestReadTimestamp: Math.max(0, createdAt - 1)
      },
      { timer, connection }
    );
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
  ): Promise<{
    validatedModel: CreateOrUpdateDropModel;
    groupIdsUserIsEligibleFor: string[];
  }> {
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
    return { validatedModel, groupIdsUserIsEligibleFor };
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

  private async verifyChatSlowModeLimitations(
    {
      isDescriptionDrop,
      wave,
      model,
      groupIdsUserIsEligibleFor,
      bypassChatSlowModeRestrictions
    }: {
      isDescriptionDrop: boolean;
      wave: WaveEntity;
      model: CreateOrUpdateDropModel;
      groupIdsUserIsEligibleFor: string[];
      bypassChatSlowModeRestrictions?: boolean;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->verifyChatSlowModeLimitations`
    );
    try {
      if (
        isDescriptionDrop ||
        bypassChatSlowModeRestrictions ||
        model.drop_id !== null ||
        model.drop_type !== DropType.CHAT ||
        !isWaveChatSlowModeActive(wave)
      ) {
        return;
      }
      const authorId = this.getRequiredAuthorId(model);
      if (
        isWaveChatSlowModeExempt({
          authenticatedProfileId: authorId,
          wave,
          groupIdsUserIsEligibleFor
        })
      ) {
        return;
      }
      const now = Time.currentMillis();
      const cooldownMs = wave.chat_slow_mode_cooldown_ms;
      if (cooldownMs === null || cooldownMs <= 0) {
        return;
      }
      const blockedUntil = await this.wavesApiDb.reserveWaveChatDropCooldown(
        {
          waveId: wave.id,
          profileId: authorId,
          now,
          cooldownMs
        },
        { timer, connection }
      );
      if (blockedUntil !== null) {
        throw new ForbiddenException(
          `Slow mode is enabled. You can create your next chat drop at ${blockedUntil}`
        );
      }
    } finally {
      timer?.stop(
        `${CreateOrUpdateDropUseCase.name}->verifyChatSlowModeLimitations`
      );
    }
  }

  private verifyChatLinksAreAllowed({
    isDescriptionDrop,
    wave,
    model,
    groupIdsUserIsEligibleFor,
    bypassChatLinkRestrictions
  }: {
    isDescriptionDrop: boolean;
    wave: WaveEntity;
    model: CreateOrUpdateDropModel;
    groupIdsUserIsEligibleFor: string[];
    bypassChatLinkRestrictions?: boolean;
  }) {
    if (
      isDescriptionDrop ||
      bypassChatLinkRestrictions ||
      !wave.chat_links_disabled ||
      model.drop_type !== DropType.CHAT ||
      isWaveCreatorOrAdmin({
        authenticatedProfileId: this.getRequiredAuthorId(model),
        wave,
        groupIdsUserIsEligibleFor
      })
    ) {
      return;
    }
    if (this.hasRestrictedChatLink(model)) {
      throw new ForbiddenException(
        `Chat drops with links are not allowed in this wave`
      );
    }
  }

  private hasRestrictedChatLink(model: CreateOrUpdateDropModel): boolean {
    return model.parts.some((part) =>
      extractUrlCandidatesFromText(part.content, Number.MAX_SAFE_INTEGER).some(
        (candidate) => !this.isAllowedChatLink(candidate)
      )
    );
  }

  private isAllowedChatLink(candidate: string): boolean {
    try {
      const url = new URL(this.normalizeChatLinkCandidate(candidate));
      if (url.origin === CLOUDFRONT_LINK) {
        return true;
      }
      return this.isAllowedGifProviderChatLink(url);
    } catch {
      return false;
    }
  }

  private isAllowedGifProviderChatLink(url: URL): boolean {
    const hostname = url.hostname.toLowerCase();
    const isAllowedGifProvider =
      url.origin === TENOR_CHAT_LINK_ORIGIN ||
      GIPHY_CHAT_LINK_HOST_REGEX.test(hostname);

    return (
      isAllowedGifProvider &&
      ALLOWED_GIF_CHAT_LINK_EXTENSION_REGEX.test(url.pathname)
    );
  }

  private normalizeChatLinkCandidate(candidate: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
      return candidate;
    }
    if (candidate.startsWith('//')) {
      return `https:${candidate}`;
    }
    return `https://${candidate}`;
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
    const authorId = this.getRequiredAuthorId(model);
    for (const part of model.parts) {
      for (const media of part.media) {
        validateDropMediaAttachment({
          mimeType: media.mime_type,
          url: media.url,
          dropType: model.drop_type
        });
        await this.verifyDropMediaUploadReference({
          mediaUploadId: media.media_upload_id ?? null,
          mediaUrl: media.url,
          mimeType: media.mime_type,
          authorId
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

  private async verifyDropMediaUploadReference({
    mediaUploadId,
    mediaUrl,
    mimeType,
    authorId
  }: {
    mediaUploadId: string | null;
    mediaUrl: string;
    mimeType: string;
    authorId: string;
  }): Promise<void> {
    if (!mediaUploadId) {
      return;
    }
    const upload = await this.dropMediaUploadsDb.findById(mediaUploadId);
    if (!upload) {
      throw new BadRequestException(`Invalid media_upload_id ${mediaUploadId}`);
    }
    if (upload.public_url !== mediaUrl) {
      throw new BadRequestException(`media_upload_id does not match media url`);
    }
    if (upload.declared_mime_type !== mimeType) {
      throw new BadRequestException(
        `media_upload_id does not match media type`
      );
    }
    if (upload.profile_id !== authorId) {
      throw new ForbiddenException(
        `media_upload_id does not belong to the drop author`
      );
    }
    if (
      upload.status !== DropMediaUploadStatus.PROCESSING &&
      upload.status !== DropMediaUploadStatus.SANITIZING &&
      upload.status !== DropMediaUploadStatus.READY
    ) {
      throw new BadRequestException(
        `media_upload_id is not ready to attach to a drop`
      );
    }
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
      for (const part of model.parts) {
        const attachmentIdsInPart = part.attachments?.map(
          (attachment) => attachment.attachment_id
        );
        if (
          attachmentIdsInPart?.length &&
          new Set(attachmentIdsInPart).size !== attachmentIdsInPart.length
        ) {
          throw new BadRequestException(
            `Drop part contains duplicate attachments`
          );
        }
      }
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
      model: inputModel,
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
    // Keep this guard at the persistence boundary too; this method can be
    // reused independently of execute() and the normalization is idempotent.
    const model = this.normalizeMentionedGroups(inputModel);
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
          signature: model.signature,
          hide_link_preview: model.hide_link_preview,
          is_additional_action_promised: model.is_additional_action_promised
        },
        connection
      ),
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
          over_threshold_since_ms: null,
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
                media_upload_id: media.media_upload_id ?? null,
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
    await this.dropMediaUploadsDb.attachUploadsToDrop({
      mediaUploadIds: parts
        .flatMap((part) => part.media.map((media) => media.media_upload_id))
        .filter((mediaUploadId): mediaUploadId is string => !!mediaUploadId),
      dropId,
      waveId: wave.id,
      connection,
      timer
    });
    await waveScoreService.markWaveScoresDirtyBestEffort(
      [wave.id],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      {
        timer,
        connection
      }
    );
    const pendingPushNotificationIds = await this.notifyWaveDropRecipients(
      {
        model,
        wave,
        directlyMentionedIdentityIds: resolvedMentionedUsers.mentionedUserIds,
        // Group mention notifications, including @all, are create-only so an
        // edit cannot resend a wave-wide or permission-derived notification.
        groupMentionNotificationsEnabled: updatedAt === null
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
    // Contributors, admins, and developers are convenience expansions. Anyone
    // with chat access could mention the same profiles individually, so only
    // @all retains the wave creator/admin restriction. In particular,
    // @devs6529 is intentionally available to every chat participant: it is a
    // shorter, more reliable form of directly mentioning the configured team.
    const isCreator = wave.created_by === this.getRequiredAuthorId(model);
    const isAdmin =
      wave.admin_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(wave.admin_group_id);
    if (
      model.mentioned_groups.includes(DropGroupMention.ALL) &&
      !isCreator &&
      !isAdmin
    ) {
      throw new ForbiddenException(
        `Only wave creators or admins can mention @all`
      );
    }
  }

  private getPermissionMentionSourceGroupIds({
    model,
    wave
  }: {
    model: CreateOrUpdateDropModel;
    wave: WaveEntity;
  }): string[] {
    return collections.distinct(
      [
        model.mentioned_groups.includes(DropGroupMention.CONTRIBUTORS)
          ? wave.chat_group_id
          : null,
        model.mentioned_groups.includes(DropGroupMention.ADMINS)
          ? wave.admin_group_id
          : null
      ].filter((groupId): groupId is string => groupId !== null)
    );
  }

  private collectPermissionMentionCandidates({
    model,
    wave,
    followerIdentityIds,
    permissionGroupMemberIds,
    configuredDeveloperIds
  }: {
    model: CreateOrUpdateDropModel;
    wave: WaveEntity;
    followerIdentityIds: string[];
    permissionGroupMemberIds: ReadonlySet<string>;
    configuredDeveloperIds: string[];
  }): string[] {
    return collections.distinct([
      ...Array.from(permissionGroupMemberIds),
      ...configuredDeveloperIds,
      ...(model.mentioned_groups.includes(DropGroupMention.ADMINS)
        ? [wave.created_by]
        : []),
      // Product rule: when Chat access is Anyone, every wave follower is
      // allowed to contribute and is therefore in the @contributors audience.
      // Followers provide the finite, wave-relevant subset of that otherwise
      // unbounded public audience. Visibility and mute filtering still apply.
      ...(model.mentioned_groups.includes(DropGroupMention.CONTRIBUTORS) &&
      wave.chat_group_id === null
        ? followerIdentityIds
        : [])
    ]);
  }

  private async resolvePermissionGroupMentionRecipients(
    {
      model,
      wave,
      followerIdentityIds
    }: {
      model: CreateOrUpdateDropModel;
      wave: WaveEntity;
      followerIdentityIds: string[];
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<string[]> {
    const permissionMentionGroups = [
      DropGroupMention.CONTRIBUTORS,
      DropGroupMention.ADMINS,
      DropGroupMention.DEVS_6529
    ];
    if (
      !permissionMentionGroups.some((group) =>
        model.mentioned_groups.includes(group)
      )
    ) {
      return [];
    }
    const sourceGroupIds = this.getPermissionMentionSourceGroupIds({
      model,
      wave
    });
    const configuredDeveloperIds = model.mentioned_groups.includes(
      DropGroupMention.DEVS_6529
    )
      ? collections.distinct(
          env
            .getStringArray('DEVS_6529_MENTION_PROFILE_IDS', ',')
            .map((id) => id.trim())
            .filter(Boolean)
        )
      : [];
    this.warnIfDeveloperMentionHasNoRecipients({
      model,
      configuredDeveloperIds
    });
    const permissionGroupMemberIds =
      await this.findPermissionMentionGroupMemberIds(sourceGroupIds, {
        timer,
        connection
      });
    const existingConfiguredDeveloperIds = configuredDeveloperIds.length
      ? await identitiesDb
          .getIdentitiesByIds(configuredDeveloperIds, connection)
          .then((identities) =>
            identities
              .map((identity) => identity.profile_id)
              .filter((profileId): profileId is string => profileId !== null)
          )
      : [];
    const candidates = this.collectPermissionMentionCandidates({
      model,
      wave,
      followerIdentityIds,
      permissionGroupMemberIds,
      configuredDeveloperIds: existingConfiguredDeveloperIds
    });
    if (wave.visibility_group_id === null || !candidates.length) {
      return candidates;
    }
    // Visibility applies uniformly to every permission-derived recipient,
    // including the wave creator and configured developers. This preserves
    // the pre-refactor behavior and prevents global mentions exposing profiles
    // that cannot view the wave.
    const visibleMemberships =
      await this.userGroupsService.findIdentityGroupMemberships(
        {
          groupIds: [wave.visibility_group_id],
          profileIds: candidates
        },
        { timer, connection }
      );
    const visibleRecipientIds = new Set(
      visibleMemberships.map((membership) => membership.profileId)
    );
    return candidates.filter((profileId) => visibleRecipientIds.has(profileId));
  }

  private warnIfDeveloperMentionHasNoRecipients({
    model,
    configuredDeveloperIds
  }: {
    model: CreateOrUpdateDropModel;
    configuredDeveloperIds: string[];
  }): void {
    if (
      !model.mentioned_groups.includes(DropGroupMention.DEVS_6529) ||
      configuredDeveloperIds.length
    ) {
      return;
    }
    const now = Time.currentMillis();
    if (now < this.nextMissingDeveloperMentionWarningAt) {
      return;
    }
    this.nextMissingDeveloperMentionWarningAt =
      now + MISSING_DEVELOPER_MENTION_WARNING_INTERVAL_MS;
    this.logger.warn(
      '[@devs6529 is configured with no DEVS_6529_MENTION_PROFILE_IDS recipients]'
    );
  }

  private async findPermissionMentionGroupMemberIds(
    groupIds: string[],
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<Set<string>> {
    const memberIds = new Set<string>();
    if (!groupIds.length) {
      return memberIds;
    }

    // The database query is paged to keep each read bounded. The complete,
    // de-duplicated recipient set is retained because the notifier requires
    // the full audience for this drop.
    let cursor: { groupId: string; profileId: string } | null = null;
    do {
      const page = await this.userGroupsService.findIdentityGroupMembershipPage(
        { groupIds, after: cursor },
        { timer, connection }
      );
      for (const membership of page.memberships) {
        memberIds.add(membership.profileId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return memberIds;
  }

  private async resolveDropRelationshipNotifications(
    { model }: { model: CreateOrUpdateDropModel },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<DropRelationshipNotifications> {
    timer?.start(
      `${CreateOrUpdateDropUseCase.name}->resolveDropRelationshipNotifications`
    );
    const dropId = this.getRequiredDropId(model);
    const authorId = this.getRequiredAuthorId(model);
    const relatedDropIds = collections.distinct([
      ...(model.reply_to ? [model.reply_to.drop_id] : []),
      ...model.parts.flatMap((part) =>
        part.quoted_drop ? [part.quoted_drop.drop_id] : []
      )
    ]);
    if (!relatedDropIds.length) {
      timer?.stop(
        `${CreateOrUpdateDropUseCase.name}->resolveDropRelationshipNotifications`
      );
      return { replyNotification: null, quoteNotifications: [] };
    }
    const relatedDropAuthors = new Map(
      (await this.dropsDb.getDropsByIds(relatedDropIds, connection)).map(
        (drop) => [drop.id, drop.author_id]
      )
    );
    const getRelatedDropAuthor = (relatedDropId: string): string => {
      const relatedDropAuthor = relatedDropAuthors.get(relatedDropId);
      if (!relatedDropAuthor) {
        throw new NotFoundException(`Drop ${relatedDropId} not found`);
      }
      return relatedDropAuthor;
    };
    const replyNotification = model.reply_to
      ? {
          reply_drop_id: dropId,
          reply_drop_author_id: authorId,
          replied_drop_id: model.reply_to.drop_id,
          replied_drop_part: model.reply_to.drop_part_id,
          replied_drop_author_id: getRelatedDropAuthor(model.reply_to.drop_id),
          wave_id: model.wave_id
        }
      : null;
    const quoteNotifications = model.parts.flatMap<DropQuoteNotificationData>(
      (part, index) => {
        const quotedDrop = part.quoted_drop;
        return quotedDrop
          ? [
              {
                quote_drop_id: dropId,
                quote_drop_part: index + 1,
                quote_drop_author_id: authorId,
                quoted_drop_id: quotedDrop.drop_id,
                quoted_drop_part: quotedDrop.drop_part_id,
                quoted_drop_author_id: getRelatedDropAuthor(quotedDrop.drop_id),
                wave_id: model.wave_id
              }
            ]
          : [];
      }
    );
    timer?.stop(
      `${CreateOrUpdateDropUseCase.name}->resolveDropRelationshipNotifications`
    );
    return { replyNotification, quoteNotifications };
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
      directlyMentionedIdentityIds,
      groupMentionNotificationsEnabled
    }: {
      model: CreateOrUpdateDropModel;
      wave: WaveEntity;
      directlyMentionedIdentityIds: string[];
      groupMentionNotificationsEnabled: boolean;
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<number[]> {
    timer?.start(`${CreateOrUpdateDropUseCase.name}->notifyWaveDropRecipients`);
    const dropId = this.getRequiredDropId(model);
    const authorId = this.getRequiredAuthorId(model);
    const notificationMentionedGroups = groupMentionNotificationsEnabled
      ? model.mentioned_groups
      : [];
    const [
      followerRecipients,
      waveSubscribersCount,
      relationshipNotifications
    ] = await Promise.all([
      this.identitySubscriptionsDb.findWaveFollowersEligibleForDropNotifications(
        {
          waveId: wave.id,
          authorId,
          mentionedGroups: notificationMentionedGroups
        },
        connection
      ),
      this.identitySubscriptionsDb.countWaveSubscribers(wave.id, connection),
      this.resolveDropRelationshipNotifications(
        { model },
        { timer, connection }
      )
    ]);
    const permissionGroupMentionIdentityIds =
      await this.resolvePermissionGroupMentionRecipients(
        {
          model: { ...model, mentioned_groups: notificationMentionedGroups },
          wave,
          followerIdentityIds: followerRecipients.map(
            (recipient) => recipient.identity_id
          )
        },
        { timer, connection }
      );
    const eligibleMentionedIdentityIds =
      await this.filterIdentityIdsEligibleToReadWave(
        wave,
        collections.distinct([
          ...directlyMentionedIdentityIds,
          ...permissionGroupMentionIdentityIds
        ]),
        { timer, connection }
      );
    const mutedDirectMentionedIdentityIds = new Set(
      await this.identitySubscriptionsDb.findMutedWaveReaders(
        wave.id,
        eligibleMentionedIdentityIds,
        connection
      )
    );
    const directMentionIdentityIds = collections.distinct(
      eligibleMentionedIdentityIds.filter(
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
          replyNotification: relationshipNotifications.replyNotification,
          quoteNotifications: relationshipNotifications.quoteNotifications,
          mentionedIdentityIds,
          allDropsSubscriberIds
        },
        wave.visibility_group_id,
        { timer, connection }
      );
    timer?.stop(`${CreateOrUpdateDropUseCase.name}->notifyWaveDropRecipients`);
    return pendingPushNotificationIds;
  }

  private async filterIdentityIdsEligibleToReadWave(
    wave: WaveEntity,
    identityIds: string[],
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<string[]> {
    const visibilityGroupIds = [wave.visibility_group_id].filter(
      (groupId): groupId is string => groupId !== null
    );
    if (wave.parent_wave_id) {
      const parentWave = await this.wavesApiDb.findWaveById(
        wave.parent_wave_id,
        connection
      );
      if (!parentWave) {
        this.logger.warn(
          `Cannot resolve parent wave ${wave.parent_wave_id} while filtering direct mention recipients for wave ${wave.id}`
        );
        return [];
      }
      if (parentWave.visibility_group_id) {
        visibilityGroupIds.push(parentWave.visibility_group_id);
      }
    }
    const distinctIdentityIds = collections.distinct(identityIds);
    if (!visibilityGroupIds.length || !distinctIdentityIds.length) {
      return distinctIdentityIds;
    }

    const eligibleIdentitySets = await Promise.all(
      collections.distinct(visibilityGroupIds).map(async (groupId) => {
        const eligibleIdentityIds =
          await this.userGroupsService.findIdentitiesInGroups([groupId], {
            timer,
            connection
          });
        return new Set(eligibleIdentityIds);
      })
    );
    return distinctIdentityIds.filter((identityId) =>
      eligibleIdentitySets.every((eligibleIds) => eligibleIds.has(identityId))
    );
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
  attachmentsDb,
  dropMediaUploadsDb
);
