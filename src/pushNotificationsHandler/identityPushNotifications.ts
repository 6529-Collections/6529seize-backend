import { In, Like } from 'typeorm';
import { userGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { ApiIdentity } from '../api-serverless/src/generated/models/ApiIdentity';
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';
import {
  directMessageWaveDisplayService,
  resolveWavePictureOverride
} from '../api-serverless/src/waves/direct-message-wave-display.service';
import { getDataSource } from '../db';
import {
  AttachmentEntity,
  AttachmentKind,
  DropAttachmentEntity
} from '../entities/IAttachment';
import { DropEntity, DropMediaEntity, DropPartEntity } from '../entities/IDrop';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import {
  DEFAULT_PUSH_NOTIFICATION_SETTINGS,
  PushNotificationSettingsData,
  PushNotificationSettingsEntity
} from '../entities/IPushNotificationSettings';
import { WaveEntity } from '../entities/IWave';
import { WaveReaderMetricEntity } from '../entities/IWaveReaderMetric';
import { Logger } from '../logging';
import { IdentityNotificationsDb } from '../notifications/identity-notifications.db';
import type { SubscriptionCoverageNotificationData } from '@/notifications/user-notification.types';
import { dbSupplier } from '../sql-executor';
import { sumBadgeContributions } from './badge-count';
import {
  buildDropVotePushBody,
  buildDropVotePushTitle,
  formatSignedLocaleNumber,
  getRatingChangeEmoji
} from '@/pushNotificationsHandler/drop-vote-push-notification-text';
import {
  getDropMediaInfoForPush,
  truncatePushNotificationFileName
} from '@/pushNotificationsHandler/push-notification-text';
import type { PushNotificationFileInfo } from '@/pushNotificationsHandler/push-notification-text';
import {
  PushNotificationMessageInput,
  PushNotificationSendResult,
  sendMessages
} from '@/pushNotificationsHandler/sendPushNotifications';
import { identityMutesDb } from '../api-serverless/src/identity-mutes/identity-mutes.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { wsListenersNotifier } from '../api-serverless/src/ws/ws-listeners-notifier';
import { identityPushNotificationAccess } from '@/pushNotificationsHandler/identity-push-notification-access';
import {
  getEnabledCauses,
  isNotificationEnabledForDevice
} from '@/pushNotificationsHandler/identity-push-notification-settings';
import { buildSubscriptionCoveragePushNotificationData } from '@/pushNotificationsHandler/subscription-coverage-push-notification';
import {
  appendWavePushNotificationContext,
  buildAllDropsPushNotificationTitle,
  buildWavePushNotificationContext,
  buildWavePushNotificationTitle
} from '@/pushNotificationsHandler/wave-push-notification-title';
import type { WavePushNotificationContext } from '@/pushNotificationsHandler/wave-push-notification-title';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_IDENTITY');
const SKIP_NOTIFICATION_PUSH = Symbol('SKIP_NOTIFICATION_PUSH');

const identityNotificationsDb = new IdentityNotificationsDb(dbSupplier);

interface IdentityPushNotificationMessage {
  input: PushNotificationMessageInput;
  identityId: string;
  device: PushNotificationDevice;
}

interface WavePresentation {
  readonly context: WavePushNotificationContext;
  readonly picture: string | null;
}

interface WavePresentationSource {
  readonly waveName: string;
  readonly isDirectMessage: boolean;
  readonly participantCount: number;
  readonly picture: string | null;
}

type WavePresentationResolver = (
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity
) => Promise<WavePresentation>;

type AdditionalDataNumber = string | number | null;

interface AdditionalDataPayload {
  amount?: AdditionalDataNumber;
  rater_rating?: AdditionalDataNumber;
  total?: AdditionalDataNumber;
  category?: string | null;
  vote?: AdditionalDataNumber;
  vote_change?: AdditionalDataNumber;
  total_vote?: AdditionalDataNumber;
  reaction?: string | null;
  poll_options?: unknown;
}

interface PollVoteAdditionalDataOption {
  option_no: number;
  option_string: string;
}

function extractAdditionalData<T extends object = AdditionalDataPayload>(
  notification: IdentityNotificationEntity
): T {
  return (notification.additional_data ?? {}) as unknown as T;
}

function createWavePresentationResolver(): WavePresentationResolver {
  const sourceByWaveAndRecipient = new Map<
    string,
    Promise<WavePresentationSource>
  >();

  return async (notification) => {
    const cacheKey = JSON.stringify([
      notification.wave_id,
      notification.identity_id
    ]);
    let sourcePromise = sourceByWaveAndRecipient.get(cacheKey);
    if (!sourcePromise) {
      sourcePromise = loadWavePresentationSourceForRecipient(notification);
      sourceByWaveAndRecipient.set(cacheKey, sourcePromise);
    }

    let source: WavePresentationSource;
    try {
      source = await sourcePromise;
    } catch (error) {
      sourceByWaveAndRecipient.delete(cacheKey);
      throw error;
    }

    return {
      context: buildWavePushNotificationContext({
        waveName: source.waveName,
        isDirectMessage: source.isDirectMessage,
        participantCount: source.participantCount
      }),
      picture: source.picture
    };
  };
}

function numbersOrNull(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRatingUpdateBody({
  prefixLines = [],
  amount,
  raterRating,
  raterHandle,
  total,
  totalLabel
}: {
  prefixLines?: string[];
  amount: number;
  raterRating: number | null;
  raterHandle: string;
  total: number;
  totalLabel: string;
}): string {
  const lines = [
    ...prefixLines,
    `Change: ${formatSignedLocaleNumber(amount)}`,
    raterRating === null
      ? null
      : `${raterHandle}'s rating: ${formatSignedLocaleNumber(raterRating)}`,
    `${totalLabel}: ${formatSignedLocaleNumber(total)}`
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

async function getDeviceSettings(
  profileId: string,
  deviceId: string
): Promise<PushNotificationSettingsData> {
  const result = await getDataSource()
    .getRepository(PushNotificationSettingsEntity)
    .findOneBy({ profile_id: profileId, device_id: deviceId });

  if (!result) {
    return { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS };
  }

  return {
    identity_subscribed: result.identity_subscribed,
    identity_mentioned: result.identity_mentioned,
    identity_rep: result.identity_rep,
    identity_nic: result.identity_nic,
    drop_quoted: result.drop_quoted,
    drop_replied: result.drop_replied,
    drop_voted: result.drop_voted,
    drop_reacted: result.drop_reacted,
    drop_boosted: result.drop_boosted,
    wave_created: result.wave_created,
    subscription_coverage: result.subscription_coverage
  };
}

function getDeviceTokenKey(deviceId: string, token: string): string {
  return JSON.stringify([deviceId, token]);
}

function buildMultiProfileTitlePrefix(profileHandle: string): string {
  const normalizedHandle = profileHandle.startsWith('@')
    ? profileHandle.slice(1)
    : profileHandle;
  return `[${normalizedHandle}]`;
}

async function getSharedDeviceTokenKeysForOtherProfiles(
  devices: PushNotificationDevice[]
): Promise<Map<string, Set<string>>> {
  if (devices.length === 0) {
    return new Map();
  }

  const params: Record<string, string> = {};
  const deviceAndTokenConditions: string[] = [];

  devices.forEach((device, index) => {
    const deviceIdParam = `deviceId${index}`;
    const tokenParam = `token${index}`;
    params[deviceIdParam] = device.device_id;
    params[tokenParam] = device.token;
    deviceAndTokenConditions.push(
      `(d.device_id = :${deviceIdParam} AND d.token = :${tokenParam})`
    );
  });

  const rows = await getDataSource()
    .getRepository(PushNotificationDevice)
    .createQueryBuilder('d')
    .select('d.device_id', 'device_id')
    .addSelect('d.token', 'token')
    .addSelect('d.profile_id', 'profile_id')
    .where(`(${deviceAndTokenConditions.join(' OR ')})`, params)
    .getRawMany<{ device_id: string; token: string; profile_id: string }>();

  return rows.reduce((acc, row) => {
    const key = getDeviceTokenKey(row.device_id, row.token);
    if (!acc.has(key)) {
      acc.set(key, new Set());
    }
    acc.get(key)!.add(row.profile_id);
    return acc;
  }, new Map<string, Set<string>>());
}

export async function sendIdentityNotificationsBatch(
  ids: number[]
): Promise<number[]> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return [];
  }

  logger.info(`Sending identity notifications: ${uniqueIds.join(',')}`);

  const notifications = await getDataSource()
    .getRepository(IdentityNotificationEntity)
    .find({ where: { id: In(uniqueIds) } });
  const notificationsById = new Map(
    notifications.map((notification) => [Number(notification.id), notification])
  );
  // These rows are already durable and visible in the authenticated REST feed.
  // Mobile push mute/device/delivery rules do not suppress feed notifications,
  // so realtime invalidation intentionally remains independent and idempotent.
  await wsListenersNotifier.notifyAboutIdentityNotificationsChanged(
    notifications.map((notification) => notification.identity_id)
  );
  let mutedNotificationIds: Set<number>;
  try {
    mutedNotificationIds = await findMutedNotificationIds(notifications);
  } catch (error) {
    logger.error(
      'Failed to apply notification visibility filters; retrying push notifications',
      error
    );
    return notifications.map((notification) => Number(notification.id));
  }

  uniqueIds
    .filter((id) => !notificationsById.has(id))
    .forEach((id) => logger.error(`Notification not found: ${id}`));

  const failedIds: number[] = [];
  const waveAccessCache = new Map<string, Promise<boolean>>();
  const wavePresentationResolver = createWavePresentationResolver();
  const messagesByNotification = await Promise.all(
    uniqueIds.map(async (id) => {
      const notification = notificationsById.get(id);
      if (!notification) {
        return [];
      }
      if (mutedNotificationIds.has(Number(notification.id))) {
        logger.info(
          `[ID ${notification.id}] Identity ${notification.additional_identity_id} is muted by user ${notification.identity_id}`
        );
        return [];
      }
      try {
        return await buildIdentityNotificationMessages(
          notification,
          waveAccessCache,
          wavePresentationResolver
        );
      } catch (error) {
        logger.error(`Failed to build notification ${id}: ${error}`);
        failedIds.push(id);
        return [];
      }
    })
  );
  const messages = messagesByNotification.flat();

  if (messages.length === 0) {
    return failedIds;
  }

  try {
    const results = await sendMessages(
      messages.map((message) => message.input)
    );
    failedIds.push(...(await handleSendResults(messages, results)));
  } catch (error) {
    logger.error(`Failed to send notification messages: ${error}`);
    failedIds.push(...messages.map((message) => message.input.notification_id));
  }

  return Array.from(new Set(failedIds));
}

async function findMutedNotificationIds(
  notifications: IdentityNotificationEntity[]
): Promise<Set<number>> {
  const notificationRows = notifications.map((notification) => ({
    notification_id: Number(notification.id),
    identity_id: notification.identity_id,
    additional_identity_id: notification.additional_identity_id,
    related_drop_id: notification.related_drop_id,
    related_drop_2_id: notification.related_drop_2_id
  }));
  const unmutedRows =
    await identityMutesDb.filterMutedNotificationRows(notificationRows);
  const deliverableRows =
    await contentModerationDb.filterBlockedNotificationRows(unmutedRows);
  const visibleRows =
    await contentModerationDb.filterUnavailableDropNotificationRows(
      deliverableRows
    );
  const unmutedNotificationIds = new Set(
    visibleRows.map((row) => row.notification_id)
  );
  return new Set(
    notificationRows
      .filter((row) => !unmutedNotificationIds.has(row.notification_id))
      .map((row) => row.notification_id)
  );
}

async function buildIdentityNotificationMessages(
  notification: IdentityNotificationEntity,
  waveAccessCache: Map<string, Promise<boolean>>,
  wavePresentationResolver: WavePresentationResolver
): Promise<IdentityPushNotificationMessage[]> {
  if (notification.read_at) {
    logger.info(
      `[ID ${notification.id}] Notification already read at ${notification.read_at}`
    );
    return [];
  }

  if (notification.wave_id) {
    const readerMetric = await getDataSource()
      .getRepository(WaveReaderMetricEntity)
      .findOneBy({
        wave_id: notification.wave_id,
        reader_id: notification.identity_id
      });
    if (readerMetric?.muted) {
      logger.info(
        `[ID ${notification.id}] Wave ${notification.wave_id} is muted by user ${notification.identity_id}`
      );
      return [];
    }
  }

  const userDevices = await getDataSource()
    .getRepository(PushNotificationDevice)
    .findBy({
      profile_id: notification.identity_id
    });

  if (userDevices.length === 0) {
    logger.info(
      `[ID ${notification.id}] No device token found for user ${notification.identity_id}`
    );
    return [];
  }

  const profileIdsByDeviceToken =
    await getSharedDeviceTokenKeysForOtherProfiles(userDevices);
  const sharedDeviceTokenKeys = new Set(
    Array.from(profileIdsByDeviceToken.entries())
      .filter(([, profileIds]) =>
        Array.from(profileIds).some((id) => id !== notification.identity_id)
      )
      .map(([key]) => key)
  );
  const targetProfile = await getIdentityOrThrow(notification.identity_id);
  const targetProfileHandle =
    targetProfile.normalised_handle ??
    targetProfile.handle ??
    notification.identity_id;

  let multiProfileTitlePrefix: string | null = null;
  if (sharedDeviceTokenKeys.size > 0) {
    multiProfileTitlePrefix = buildMultiProfileTitlePrefix(targetProfileHandle);
  }

  const canRecipientReadRelatedContent =
    await identityPushNotificationAccess.canRecipientReadRelatedContent(
      notification,
      waveAccessCache
    );
  if (!canRecipientReadRelatedContent) {
    logger.warn(
      `[ID ${notification.id}] Skipping push because identity ${notification.identity_id} cannot read the related content in wave ${notification.wave_id}`
    );
    return [];
  }

  const notificationData = await generateNotificationData(
    notification,
    targetProfile,
    wavePresentationResolver
  );
  if (notificationData === SKIP_NOTIFICATION_PUSH) {
    logger.info(`[ID ${notification.id}] Skipping push notification`);
    return [];
  }
  if (notificationData === null) {
    throw new Error(
      `[ID ${notification.id}] Failed to generate notification data`
    );
  }

  const { title, body, data, imageUrl } = notificationData;

  return (
    await Promise.all(
      userDevices.map(
        async (device): Promise<IdentityPushNotificationMessage | null> => {
          const recipientSettings = await getDeviceSettings(
            notification.identity_id,
            device.device_id
          );
          if (
            !isNotificationEnabledForDevice(
              notification.cause,
              recipientSettings
            )
          ) {
            logger.info(
              `[ID ${notification.id}] Notification type ${notification.cause} disabled for device ${device.device_id}`
            );
            return null;
          }

          const deviceKey = getDeviceTokenKey(device.device_id, device.token);
          const relevantProfiles =
            profileIdsByDeviceToken.get(deviceKey) ??
            new Set([notification.identity_id]);

          const contributions = await Promise.allSettled(
            Array.from(relevantProfiles).map(async (profileId) => {
              const settings = await getDeviceSettings(
                profileId,
                device.device_id
              );
              const enabledCauses = getEnabledCauses(settings);
              if (enabledCauses.length === 0) return 0;
              const eligibleGroupIds =
                await userGroupsService.getGroupsUserIsEligibleFor(profileId);
              const options: {
                enabledCauses?: IdentityNotificationCause[];
              } = { enabledCauses };
              return identityNotificationsDb.countUnreadNotificationsForIdentity(
                profileId,
                eligibleGroupIds,
                undefined,
                options
              );
            })
          );
          const badge = sumBadgeContributions(contributions);

          const shouldPrefixTitle =
            multiProfileTitlePrefix !== null &&
            sharedDeviceTokenKeys.has(deviceKey);
          const titleForDevice = shouldPrefixTitle
            ? `${multiProfileTitlePrefix} ${title}`
            : title;
          return {
            input: {
              title: titleForDevice,
              body,
              token: device.token,
              notification_id: Number(notification.id),
              extra_data: {
                ...data,
                target_profile_id: notification.identity_id,
                target_profile_handle: targetProfileHandle
              },
              badge,
              imageUrl: imageUrl ?? undefined
            },
            identityId: notification.identity_id,
            device
          };
        }
      )
    )
  ).filter((message): message is IdentityPushNotificationMessage => !!message);
}

async function handleSendResults(
  messages: IdentityPushNotificationMessage[],
  results: PushNotificationSendResult[]
): Promise<number[]> {
  const outcomesByNotificationId = new Map<
    number,
    { hasSuccess: boolean; hasRetryableFailure: boolean }
  >();
  await Promise.all(
    results.map(async (result, index) => {
      const notificationId = result.input.notification_id;
      const outcome = outcomesByNotificationId.get(notificationId) ?? {
        hasSuccess: false,
        hasRetryableFailure: false
      };
      outcomesByNotificationId.set(notificationId, outcome);
      if (result.response.success) {
        outcome.hasSuccess = true;
        return;
      }
      const message = messages[index];
      const error = result.response.error;
      if (
        error?.code === 'messaging/registration-token-not-registered' ||
        error?.code === 'messaging/invalid-registration-token'
      ) {
        logger.warn(
          `[ID ${result.input.notification_id}] token-not-registered for profile ${message.identityId} device ${message.device.device_id}`
        );
        try {
          await getDataSource().getRepository(PushNotificationDevice).delete({
            device_id: message.device.device_id,
            profile_id: message.identityId,
            token: message.device.token
          });
          logger.info(
            `[ID ${result.input.notification_id}] Deleted unregistered token row for profile ${message.identityId} device ${message.device.device_id}`
          );
        } catch (deleteError) {
          logger.error(
            `[ID ${result.input.notification_id}] Failed to delete unregistered token row for profile ${message.identityId} device ${message.device.device_id}: ${deleteError}`
          );
        }
        return;
      }
      logger.error(`Failed to send notification: ${error?.message}`, {
        error
      });
      outcome.hasRetryableFailure = true;
    })
  );

  return Array.from(outcomesByNotificationId.entries())
    .filter(([, outcome]) => !outcome.hasSuccess && outcome.hasRetryableFailure)
    .map(([notificationId]) => notificationId);
}

async function generateNotificationData(
  notification: IdentityNotificationEntity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const getAdditionalEntity = () => getAdditionalIdOrThrow(notification);

  switch (notification.cause) {
    case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      return handleIdentitySubscribed(await getAdditionalEntity());
    case IdentityNotificationCause.IDENTITY_MENTIONED:
      return handleIdentityMentioned(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.IDENTITY_REP:
      return handleIdentityRep(notification, await getAdditionalEntity());
    case IdentityNotificationCause.IDENTITY_NIC:
      return handleIdentityNic(notification, await getAdditionalEntity());
    case IdentityNotificationCause.DROP_QUOTED:
      return handleDropQuoted(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.DROP_REPLIED:
      return handleDropReplied(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.DROP_VOTED:
      return handleDropVoted(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.DROP_POLL_VOTED:
      return handleDropPollVoted(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.DROP_REACTED:
      return handleDropReacted(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.DROP_BOOSTED:
      return handleDropBoosted(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.WAVE_CREATED:
      return handleWaveCreated(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.ALL_DROPS:
      return handleAllDrops(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.PRIORITY_ALERT:
      return handlePriorityAlert(
        notification,
        await getAdditionalEntity(),
        targetProfile,
        wavePresentationResolver
      );
    case IdentityNotificationCause.SUBSCRIPTION_COVERAGE:
      return handleSubscriptionCoverage(notification, targetProfile);
    default:
      return null;
  }
}

function handleSubscriptionCoverage(
  notification: IdentityNotificationEntity,
  targetProfile: ApiIdentity
) {
  const additionalData =
    extractAdditionalData<SubscriptionCoverageNotificationData>(notification);
  const handle = targetProfile.normalised_handle ?? targetProfile.handle;
  if (!handle) {
    logger.warn(
      `[ID ${notification.id}] Skipping subscription coverage push because profile handle was not found`
    );
    return SKIP_NOTIFICATION_PUSH;
  }
  return (
    buildSubscriptionCoveragePushNotificationData(additionalData, handle) ??
    SKIP_NOTIFICATION_PUSH
  );
}

async function handleIdentitySubscribed(additionalEntity: ApiIdentity) {
  const title = `${additionalEntity.handle} is now following you`;
  const body = 'View profile';
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'profile',
    handle: additionalEntity.normalised_handle
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityRep(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const additionalData = extractAdditionalData(notification);
  const amount = numberOrZero(additionalData.amount);
  const raterRating = numbersOrNull(additionalData.rater_rating);
  const total = numberOrZero(additionalData.total);
  const category = additionalData.category;
  const categoryLine = category ? `Category: ${category}` : null;
  const raterHandle =
    additionalEntity.handle ??
    additionalEntity.normalised_handle ??
    notification.additional_identity_id ??
    'Someone';
  const title = `${getRatingChangeEmoji(amount)}${raterHandle} updated your REP`;
  const body = buildRatingUpdateBody({
    prefixLines: categoryLine ? [categoryLine] : [],
    amount,
    raterRating,
    raterHandle,
    total,
    totalLabel: 'Total REP'
  });
  const imageUrl = additionalEntity.pfp;
  const receiverProfile = await getIdentityOrThrow(notification.identity_id);
  const data = {
    redirect: 'profile',
    handle: receiverProfile.normalised_handle,
    subroute: 'rep'
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityNic(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const additionalData = extractAdditionalData(notification);
  const amount = numberOrZero(additionalData.amount);
  const raterRating = numbersOrNull(additionalData.rater_rating);
  const total = numberOrZero(additionalData.total);
  const raterHandle =
    additionalEntity.handle ??
    additionalEntity.normalised_handle ??
    notification.additional_identity_id ??
    'Someone';
  const title = `${getRatingChangeEmoji(amount)}${raterHandle} updated your NIC rating`;
  const body = buildRatingUpdateBody({
    amount,
    raterRating,
    raterHandle,
    total,
    totalLabel: 'Total NIC'
  });
  const imageUrl = additionalEntity.pfp;
  const receiverProfile = await getIdentityOrThrow(notification.identity_id);
  const data = {
    redirect: 'profile',
    handle: receiverProfile.normalised_handle,
    subroute: 'identity'
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityMentioned(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const userProfile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: notification.identity_id },
      {}
    );
  if (!userProfile?.id) {
    throw new Error(`[ID ${notification.id}] User profile not found`);
  }
  const dropPartMention = await getDropPart(notification, userProfile.handle!);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = buildWavePushNotificationTitle({
    actorHandle: getIdentityDisplayHandle(additionalEntity),
    action: { type: 'mention' },
    context: wavePresentation.context
  });
  const body = await getDropBodyTextForPush(notification, dropPartMention);
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropQuoted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = buildWavePushNotificationTitle({
    actorHandle: getIdentityDisplayHandle(additionalEntity),
    action: { type: 'quote' },
    context: wavePresentation.context
  });
  const imageUrl = additionalEntity.pfp;
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropReplied(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = buildWavePushNotificationTitle({
    actorHandle: getIdentityDisplayHandle(additionalEntity),
    action: { type: 'reply' },
    context: wavePresentation.context
  });
  const body = await getDropBodyTextForPush(notification, dropPart);
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropVoted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const additionalData = extractAdditionalData(notification);
  const vote = Number(additionalData.vote);
  const rawVoteChange = additionalData.vote_change;
  const voteChange = rawVoteChange == null ? null : Number(rawVoteChange);
  const totalVote = numbersOrNull(additionalData.total_vote);
  if (!Number.isFinite(vote)) {
    throw new TypeError(
      `[ID ${notification.id}] Vote additional data not found`
    );
  }
  if (voteChange !== null && !Number.isFinite(voteChange)) {
    throw new TypeError(
      `[ID ${notification.id}] Vote change additional data is invalid`
    );
  }
  if (vote === 0 && (voteChange === null || voteChange === 0)) {
    return SKIP_NOTIFICATION_PUSH;
  }
  const imageUrl = additionalEntity.pfp;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const dropBody = await getDropBodyTextForPush(notification, dropPart, '');
  const voterHandle =
    additionalEntity.handle ??
    additionalEntity.normalised_handle ??
    notification.additional_identity_id ??
    'Someone';
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = appendWavePushNotificationContext(
    buildDropVotePushTitle({
      voterHandle,
      vote,
      voteChange
    }),
    wavePresentation.context
  );
  const body = buildDropVotePushBody({
    dropBody,
    vote,
    voteChange,
    totalVote
  });
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropPollVoted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const pollOptions = getPollVoteOptions(notification);
  if (!pollOptions.length) {
    throw new Error(
      `[ID ${notification.id}] Poll vote additional data not found`
    );
  }
  const imageUrl = additionalEntity.pfp;
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const voterHandle =
    additionalEntity.handle ??
    additionalEntity.normalised_handle ??
    notification.additional_identity_id ??
    'Someone';
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = appendWavePushNotificationContext(
    `${voterHandle} voted on your poll`,
    wavePresentation.context
  );
  const body =
    pollOptions.length === 1
      ? `Option: ${pollOptions[0].option_string}`
      : `Options: ${pollOptions.map((option) => option.option_string).join(', ')}`;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

function getPollVoteOptions(
  notification: IdentityNotificationEntity
): PollVoteAdditionalDataOption[] {
  const rawOptions = extractAdditionalData(notification).poll_options;
  if (!Array.isArray(rawOptions)) {
    return [];
  }
  return rawOptions
    .map((option) => {
      const optionNo = numbersOrNull(option.option_no);
      const optionString = option.option_string;
      if (optionNo === null || typeof optionString !== 'string') {
        return null;
      }
      return {
        option_no: optionNo,
        option_string: optionString
      };
    })
    .filter(
      (option): option is PollVoteAdditionalDataOption => option !== null
    );
}

async function handleDropReacted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const reaction = extractAdditionalData(notification).reaction;
  if (!reaction) {
    throw new Error(
      `[ID ${notification.id}] Reaction additional data not found`
    );
  }
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = buildWavePushNotificationTitle({
    actorHandle: getIdentityDisplayHandle(additionalEntity),
    action: { type: 'reaction', reaction },
    context: wavePresentation.context
  });
  const imageUrl = additionalEntity.pfp;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropBoosted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = appendWavePushNotificationContext(
    `${getIdentityDisplayHandle(additionalEntity)} boosted your drop 🔥`,
    wavePresentation.context
  );
  const imageUrl = additionalEntity.pfp;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function getIdentityOrThrow(identityId: string | null) {
  if (!identityId) {
    throw new Error(`Identity id not provided`);
  }
  const profile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: identityId },
      {}
    );
  if (!profile?.id) {
    throw new Error(`Profile not found for identity ${identityId}`);
  }
  return profile;
}

async function getAdditionalIdOrThrow(
  notification: IdentityNotificationEntity
) {
  return getIdentityOrThrow(notification.additional_identity_id);
}

async function getDrop(notification: IdentityNotificationEntity) {
  const dropId = notification.related_drop_id;
  if (!dropId) {
    throw new Error(`[ID ${notification.id}] Drop id not found`);
  }
  const drop = await getDataSource().getRepository(DropEntity).findOneBy({
    id: dropId
  });
  return drop;
}

async function getDropPart(
  notification: IdentityNotificationEntity,
  handle?: string
) {
  const dropId = notification.related_drop_id;
  if (!dropId) {
    throw new Error(`[ID ${notification.id}] Drop id not found`);
  }
  const query: any = { drop_id: dropId };
  if (handle) {
    query['content'] = Like(`%@[${handle}]%`);
  }
  return getDataSource().getRepository(DropPartEntity).findOneBy(query);
}

async function getDropBodyTextForPush(
  notification: IdentityNotificationEntity,
  dropPart: DropPartEntity | null,
  emptyFallback = 'View drop'
): Promise<string> {
  const rawContent = dropPart?.content;
  const rawContentTrimmed = rawContent?.trim();
  const hasText = rawContentTrimmed != null && rawContentTrimmed !== '';
  const dropId = notification.related_drop_id;

  let mediaRows: DropMediaEntity[] = [];
  if (dropId) {
    const mediaRepo = getDataSource().getRepository(DropMediaEntity);
    if (dropPart?.drop_part_id != null) {
      mediaRows = await mediaRepo.find({
        where: { drop_id: dropId, drop_part_id: dropPart.drop_part_id },
        order: { id: 'ASC' }
      });
    }
    if (mediaRows.length === 0 && !dropPart) {
      mediaRows = await mediaRepo.find({
        where: { drop_id: dropId },
        order: { drop_part_id: 'ASC', id: 'ASC' }
      });
    }
  }

  if (hasText) {
    return rawContentTrimmed;
  }

  const mediaInfos = mediaRows.map((row) =>
    getDropMediaInfoForPush(row.url, row.mime_type)
  );
  const attachmentInfos = await getDropAttachmentInfosForPush(dropId, dropPart);
  const attachmentText = getAttachmentBodyText([
    ...mediaInfos,
    ...attachmentInfos
  ]);

  if (attachmentText) {
    return attachmentText;
  }
  return emptyFallback;
}

function getAttachmentBodyText(
  attachments: PushNotificationFileInfo[]
): string | null {
  if (attachments.length === 0) {
    return null;
  }
  if (attachments.length > 1) {
    return `${attachments.length} attachments`;
  }
  const attachment = attachments[0];
  const label = `${attachment.label} attachment`;
  return attachment.fileName ? `${label} · ${attachment.fileName}` : label;
}

async function getDropAttachmentInfosForPush(
  dropId: string | null,
  dropPart: DropPartEntity | null
): Promise<PushNotificationFileInfo[]> {
  if (!dropId) {
    return [];
  }
  const dropAttachmentRepo =
    getDataSource().getRepository(DropAttachmentEntity);
  let dropAttachments: DropAttachmentEntity[] = [];
  if (dropPart?.drop_part_id != null) {
    dropAttachments = await dropAttachmentRepo.find({
      where: { drop_id: dropId, drop_part_id: dropPart.drop_part_id }
    });
  }
  if (dropAttachments.length === 0 && !dropPart) {
    dropAttachments = await dropAttachmentRepo.find({
      where: { drop_id: dropId },
      order: { drop_part_id: 'ASC', attachment_id: 'ASC' }
    });
  }
  const attachmentIds = dropAttachments.map(
    (dropAttachment) => dropAttachment.attachment_id
  );
  if (attachmentIds.length === 0) {
    return [];
  }
  const attachments = await getDataSource()
    .getRepository(AttachmentEntity)
    .find({
      where: { id: In(attachmentIds) }
    });
  const attachmentsById = new Map(
    attachments.map((attachment) => [attachment.id, attachment])
  );
  return attachmentIds.map((attachmentId) =>
    getAttachmentInfoForPush(attachmentsById.get(attachmentId))
  );
}

function getAttachmentInfoForPush(
  attachment: AttachmentEntity | undefined
): PushNotificationFileInfo {
  if (!attachment) {
    return { label: 'File', fileName: null };
  }
  const label = getAttachmentLabelForPush(attachment.kind);
  const fileName = attachment.original_file_name?.trim();
  return {
    label,
    fileName: fileName ? truncatePushNotificationFileName(fileName) : null
  };
}

function getAttachmentLabelForPush(kind: AttachmentKind): string {
  switch (kind) {
    case AttachmentKind.PDF:
      return 'PDF';
    case AttachmentKind.CSV:
      return 'CSV';
    default:
      return 'Attachment';
  }
}

async function getDropSerialNo(dropId: string | null) {
  if (!dropId) {
    return null;
  }
  const drop = await getDataSource().getRepository(DropEntity).findOneBy({
    id: dropId
  });
  return drop?.serial_no ?? null;
}

async function handleWaveCreated(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const title = buildWavePushNotificationTitle({
    actorHandle: getIdentityDisplayHandle(additionalEntity),
    action: { type: 'invite' },
    context: wavePresentation.context
  });
  const body = 'View wave';
  const imageUrl = wavePresentation.picture ?? undefined;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id
  };
  return { title, body, data, imageUrl };
}

async function getWaveEntityOrThrow(
  notificationId: number,
  waveId?: string | null
) {
  if (!waveId) {
    throw new Error(`[ID ${notificationId}] Wave id missing`);
  }
  const wave = await getDataSource()
    .getRepository(WaveEntity)
    .findOneBy({ id: waveId });
  if (!wave) {
    throw new Error(`[ID ${notificationId}] Wave with id ${waveId} not found`);
  }
  return wave;
}

function getIdentityDisplayHandle(identity: ApiIdentity): string {
  return identity.handle ?? identity.normalised_handle ?? 'Someone';
}

async function loadWavePresentationSourceForRecipient(
  notification: IdentityNotificationEntity
): Promise<WavePresentationSource> {
  const wave = await getWaveEntityOrThrow(
    notification.id,
    notification.wave_id
  );
  const displayByWaveId =
    await directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext({
      waveEntities: [wave],
      contextProfileId: notification.identity_id
    });
  const display = displayByWaveId[wave.id];
  return {
    waveName: display?.name ?? wave.name,
    isDirectMessage: wave.is_direct_message === true,
    participantCount:
      display?.participantCount ?? display?.contributors?.length ?? 0,
    picture: resolveWavePictureOverride(wave.picture, display)
  };
}

async function handleAllDrops(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );
  const additionalData = extractAdditionalData(notification);
  const actorHandle = getIdentityDisplayHandle(additionalEntity);
  const title = buildAllDropsPushNotificationTitle({
    actorHandle,
    vote: additionalData.vote,
    context: wavePresentation.context
  });

  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const imageUrl = wavePresentation.picture ?? additionalEntity.pfp;
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handlePriorityAlert(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity,
  targetProfile: ApiIdentity,
  wavePresentationResolver: WavePresentationResolver
) {
  const wavePresentation = await wavePresentationResolver(
    notification,
    additionalEntity,
    targetProfile
  );

  const drop = await getDrop(notification);
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const imageUrl = wavePresentation.picture ?? additionalEntity.pfp;
  const title = appendWavePushNotificationContext(
    `🚨 ${drop?.title ?? 'Priority Alert'}`,
    wavePresentation.context
  );
  const body = await getDropBodyTextForPush(
    notification,
    dropPart,
    'View alert'
  );
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}
