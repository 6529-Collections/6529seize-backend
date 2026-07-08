import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { dropsDb } from '@/drops/drops.db';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { SubscriptionTopUp } from '@/entities/ISubscription';
import { env } from '@/env';
import { identitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { PROFILE_HANDLE_REGEX } from '@/constants';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTION_WAVE_NOTIFIER');

const SUBSCRIPTIONS_WAVE_ID_ENV = 'SUBSCRIPTIONS_WAVE_ID';
const SUBSCRIPTIONS_BOT_PROFILE_ID_ENV = 'SUBSCRIPTIONS_BOT_PROFILE_ID';
const SUBSCRIPTIONS_ADMIN_HANDLES_ENV = 'SUBSCRIPTIONS_ADMIN_HANDLES';

function sanitizeMentionHandle(handle: string): string {
  const trimmed = handle.trim();
  const bracketMention = /^@?\[([^\]]+)]$/.exec(trimmed);
  const withoutMentionSyntax = bracketMention?.[1] ?? trimmed.replace(/^@/, '');
  const sanitized = withoutMentionSyntax.trim();
  return PROFILE_HANDLE_REGEX.test(sanitized) ? sanitized : '';
}

function normalizeMentionHandles(handles: string[]): string[] {
  const normalizedHandles: string[] = [];
  const seenHandles = new Set<string>();
  for (const handle of handles) {
    const sanitized = sanitizeMentionHandle(handle);
    const normalizedHandle = sanitized.toLowerCase();
    if (!sanitized || seenHandles.has(normalizedHandle)) {
      continue;
    }
    seenHandles.add(normalizedHandle);
    normalizedHandles.push(sanitized);
  }
  return normalizedHandles;
}

export function getSubscriptionAdminHandles(): string[] {
  const rawHandles = env.getStringOrNull(SUBSCRIPTIONS_ADMIN_HANDLES_ENV);
  if (!rawHandles) {
    return [];
  }
  return normalizeMentionHandles(rawHandles.split(/[;,]/));
}

function buildMentionLine(handles: string[]): string {
  return handles.map((handle) => `@[${handle}]`).join(' ');
}

function withMentions(message: string, handles: string[]): string {
  if (!handles.length) {
    return message;
  }
  return `${message}\n\n${buildMentionLine(handles)}`;
}

function buildSubscriptionsUrl(seizeDomain: string, wallet: string): string {
  return `https://${seizeDomain}.io/${wallet}/subscriptions`;
}

export function buildDailySubscriptionsWaveMessage({
  memeId,
  seizeDomain,
  uploadLink
}: {
  memeId: number;
  seizeDomain: string;
  uploadLink: string;
}): string {
  return [
    `📋 Published provisional list of Subscriptions for [The Memes #${memeId}](https://${seizeDomain}.io/the-memes/${memeId})`,
    '',
    'View on 6529.io:',
    `https://${seizeDomain}.io/open-data/meme-subscriptions`,
    '',
    'View on Arweave:',
    uploadLink
  ].join('\n');
}

export function buildProcessedTopUpWaveMessage({
  hash,
  adminHandles
}: {
  hash: string;
  adminHandles: string[];
}): string {
  return withMentions(`Top up ${hash} already processed`, adminHandles);
}

export function buildSubscriptionTopUpWaveMessage({
  topUp,
  seizeDomain,
  etherscanLink,
  profileHandle
}: {
  topUp: Pick<SubscriptionTopUp, 'amount' | 'from_wallet'>;
  seizeDomain: string;
  etherscanLink: string;
  profileHandle?: string | null;
}): string {
  const lines = [
    `🔝 Subscription Top Up of ${topUp.amount} ETH from ${topUp.from_wallet}.`
  ];
  if (profileHandle) {
    lines.push('', `Profile: @[${profileHandle}]`);
  }
  lines.push(
    '',
    'View on 6529.io:',
    buildSubscriptionsUrl(seizeDomain, topUp.from_wallet),
    '',
    'View on Etherscan:',
    etherscanLink
  );
  return lines.join('\n');
}

export function buildNoSubscriptionFoundWaveMessage({
  airdropAddress,
  transactionLink,
  adminHandles
}: {
  airdropAddress: string;
  transactionLink: string;
  adminHandles: string[];
}): string {
  return withMentions(
    [
      'No subscription found for airdrop address:',
      '',
      airdropAddress,
      '',
      'Transaction:',
      transactionLink
    ].join('\n'),
    adminHandles
  );
}

export function buildNoBalanceFoundWaveMessage({
  consolidationKey,
  transactionLink,
  adminHandles
}: {
  consolidationKey: string;
  transactionLink: string;
  adminHandles: string[];
}): string {
  return withMentions(
    [
      'No balance found for consolidation key:',
      '',
      consolidationKey,
      '',
      'Transaction:',
      transactionLink
    ].join('\n'),
    adminHandles
  );
}

export function buildInsufficientBalanceWaveMessage({
  consolidationKey,
  transactionLink,
  adminHandles
}: {
  consolidationKey: string;
  transactionLink: string;
  adminHandles: string[];
}): string {
  return withMentions(
    [
      'Insufficient balance for consolidation key:',
      '',
      consolidationKey,
      '',
      'Transaction:',
      transactionLink
    ].join('\n'),
    adminHandles
  );
}

async function postSubscriptionWaveDropBestEffort({
  message,
  mentionedUsers = []
}: {
  message: string;
  mentionedUsers?: string[];
}): Promise<void> {
  const waveId = env.getStringOrNull(SUBSCRIPTIONS_WAVE_ID_ENV);
  const botProfileId = env.getStringOrNull(SUBSCRIPTIONS_BOT_PROFILE_ID_ENV);
  if (!waveId || !botProfileId) {
    logger.info(
      `[SKIPPING WAVE NOTIFICATION] [${SUBSCRIPTIONS_WAVE_ID_ENV} OR ${SUBSCRIPTIONS_BOT_PROFILE_ID_ENV} NOT CONFIGURED]`
    );
    return;
  }

  try {
    const normalizedMentionedUsers = normalizeMentionHandles(mentionedUsers);
    const pendingPushNotificationIds =
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const botIdentity = await identitiesDb.getIdentityByProfileId(
            botProfileId,
            connection
          );
          if (!botIdentity) {
            logger.warn(
              `[SKIPPING WAVE NOTIFICATION] [BOT PROFILE ${botProfileId} NOT FOUND]`
            );
            return [];
          }
          const authorIdentity =
            botIdentity.handle ?? botIdentity.primary_address;
          if (!authorIdentity) {
            logger.warn(
              `[SKIPPING WAVE NOTIFICATION] [BOT PROFILE ${botProfileId} HAS NO AUTHOR IDENTITY]`
            );
            return [];
          }

          const ctx: RequestContext = { connection };
          const model: CreateOrUpdateDropModel = {
            drop_id: null,
            wave_id: waveId,
            reply_to: null,
            title: null,
            parts: [
              {
                content: message,
                quoted_drop: null,
                media: []
              }
            ],
            referenced_nfts: [],
            mentioned_users: normalizedMentionedUsers.map((handle) => ({
              handle
            })),
            mentioned_waves: [],
            metadata: [],
            author_identity: authorIdentity,
            author_id: botProfileId,
            drop_type: DropType.CHAT,
            mentioned_groups: [],
            signature: null,
            is_additional_action_promised: null
          };
          const { drop_id, pending_push_notification_ids } =
            await createOrUpdateDrop.execute(model, false, {
              connection,
              bypassChatLinkRestrictions: true,
              bypassChatSlowModeRestrictions: true
            });
          await dropsDb.updateHideLinkPreview(
            {
              drop_id,
              hide_link_preview: true
            },
            { connection }
          );
          await waveScoreService.requestWaveScoreRefreshBestEffort(
            [waveId],
            WaveScoreDirtyRefreshReason.DROP_CHANGED,
            ctx
          );
          return pending_push_notification_ids;
        }
      );

    await sendIdentityPushNotifications(pendingPushNotificationIds);
  } catch (error) {
    logger.error(`[WAVE NOTIFICATION ERROR] [${error}]`);
  }
}

async function resolveTopUpProfileHandle(
  wallet: string
): Promise<string | null> {
  try {
    const identity = await identitiesDb.getIdentityByWallet(wallet);
    return identity?.handle ?? null;
  } catch (error) {
    logger.warn(`[TOP UP PROFILE LOOKUP FAILED] [WALLET ${wallet}] [${error}]`);
    return null;
  }
}

export async function sendDailySubscriptionsWaveUpdate(params: {
  memeId: number;
  seizeDomain: string;
  uploadLink: string;
}): Promise<void> {
  await postSubscriptionWaveDropBestEffort({
    message: buildDailySubscriptionsWaveMessage(params)
  });
}

export async function sendProcessedTopUpWaveWarning(
  hash: string
): Promise<void> {
  const adminHandles = getSubscriptionAdminHandles();
  await postSubscriptionWaveDropBestEffort({
    message: buildProcessedTopUpWaveMessage({ hash, adminHandles }),
    mentionedUsers: adminHandles
  });
}

export async function sendSubscriptionTopUpWaveUpdate({
  topUp,
  seizeDomain,
  etherscanLink
}: {
  topUp: SubscriptionTopUp;
  seizeDomain: string;
  etherscanLink: string;
}): Promise<void> {
  const profileHandle = await resolveTopUpProfileHandle(topUp.from_wallet);
  await postSubscriptionWaveDropBestEffort({
    message: buildSubscriptionTopUpWaveMessage({
      topUp,
      seizeDomain,
      etherscanLink,
      profileHandle
    }),
    mentionedUsers: profileHandle ? [profileHandle] : []
  });
}

export async function sendNoSubscriptionFoundWaveWarning({
  airdropAddress,
  transactionLink
}: {
  airdropAddress: string;
  transactionLink: string;
}): Promise<void> {
  const adminHandles = getSubscriptionAdminHandles();
  await postSubscriptionWaveDropBestEffort({
    message: buildNoSubscriptionFoundWaveMessage({
      airdropAddress,
      transactionLink,
      adminHandles
    }),
    mentionedUsers: adminHandles
  });
}

export async function sendNoBalanceFoundWaveError({
  consolidationKey,
  transactionLink
}: {
  consolidationKey: string;
  transactionLink: string;
}): Promise<void> {
  const adminHandles = getSubscriptionAdminHandles();
  await postSubscriptionWaveDropBestEffort({
    message: buildNoBalanceFoundWaveMessage({
      consolidationKey,
      transactionLink,
      adminHandles
    }),
    mentionedUsers: adminHandles
  });
}

export async function sendInsufficientBalanceWaveError({
  consolidationKey,
  transactionLink
}: {
  consolidationKey: string;
  transactionLink: string;
}): Promise<void> {
  const adminHandles = getSubscriptionAdminHandles();
  await postSubscriptionWaveDropBestEffort({
    message: buildInsufficientBalanceWaveMessage({
      consolidationKey,
      transactionLink,
      adminHandles
    }),
    mentionedUsers: adminHandles
  });
}
