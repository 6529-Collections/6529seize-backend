import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { waveApiService, WaveApiService } from '@/api/waves/wave.api.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import type { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveEntity } from '@/entities/IWave';
import { env } from '@/env';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';

const logger = Logger.get('WAVE_DM_NOTIFIER');

const WAVE_DM_BOT_PROFILE_ID_ENV = 'WAVE_DM_BOT_PROFILE_ID';
const DM_PREVIEW_MAX_CHARS = 200;

function getSeizeDomain(): string {
  return process.env.NODE_ENV === 'development' ? 'staging.6529' : '6529';
}

function buildDropUrl(waveId: string, dropId: string): string {
  return `https://${getSeizeDomain()}.io/waves/${waveId}/drops/${dropId}`;
}

function extractDropPreview(
  parts: { content: string | null }[],
  maxChars: number = DM_PREVIEW_MAX_CHARS
): string {
  const fullContent = parts
    .map((part) => part.content?.trim() ?? '')
    .filter((content) => content.length > 0)
    .join('\n\n');
  if (!fullContent) {
    return '';
  }
  if (fullContent.length <= maxChars) {
    return fullContent;
  }
  return `${fullContent.slice(0, maxChars)}...`;
}

function buildDmMessage({
  waveName,
  authorHandle,
  preview,
  dropUrl
}: {
  waveName: string;
  authorHandle: string | null;
  preview: string;
  dropUrl: string;
}): string {
  const lines: string[] = [];
  lines.push(`New post in **${waveName}**`);
  if (authorHandle) {
    lines.push(`by @[${authorHandle}]`);
  }
  lines.push('');
  if (preview) {
    lines.push(`> ${preview.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }
  lines.push(`[View post](${dropUrl})`);
  return lines.join('\n');
}

export class WaveDmNotifier {
  constructor(
    private readonly userGroupsService: UserGroupsService,
    private readonly waveApiService: WaveApiService
  ) {}

  async notifyDmSubscribersOfNewDrop(
    {
      wave,
      dropId,
      authorId,
      dropParts
    }: {
      wave: WaveEntity;
      dropId: string;
      authorId: string;
      dropParts: { content: string | null }[];
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const botProfileId = env.getStringOrNull(WAVE_DM_BOT_PROFILE_ID_ENV);

    let senderProfile: ApiIdentity | null = null;

    if (botProfileId) {
      senderProfile = await identityFetcher
        .getIdentityAndConsolidationsByIdentityKey(
          { identityKey: botProfileId },
          { connection }
        )
        .catch((error) => {
          logger.warn(
            `[WAVE DM] [BOT PROFILE ${botProfileId} LOOKUP FAILED, FALLING BACK TO AUTHOR] [${error}]`
          );
          return null;
        });
    } else {
      logger.info(
        `[WAVE DM] [${WAVE_DM_BOT_PROFILE_ID_ENV} NOT CONFIGURED, USING AUTHOR AS SENDER]`
      );
    }

    if (!senderProfile) {
      senderProfile = await identityFetcher
        .getIdentityAndConsolidationsByIdentityKey(
          { identityKey: authorId },
          { connection }
        )
        .catch((error) => {
          logger.error(
            `[WAVE DM] [AUTHOR PROFILE ${authorId} LOOKUP ALSO FAILED, ABORTING] [${error}]`
          );
          return null;
        });
    }

    if (!senderProfile) {
      logger.error(
        `[WAVE DM] [NO SENDER PROFILE AVAILABLE, ABORTING] [WAVE ${wave.id}]`
      );
      return;
    }

    const subscriberIds = await identitySubscriptionsDb.findWaveDmSubscribers(
      wave.id,
      authorId,
      connection
    );
    if (!subscriberIds.length) {
      return;
    }

    const authorProfile = await identityFetcher
      .getIdentityAndConsolidationsByIdentityKey(
        { identityKey: authorId },
        { connection }
      )
      .catch(() => null);
    const authorHandle = authorProfile?.handle ?? null;

    const preview = extractDropPreview(dropParts);
    const dropUrl = buildDropUrl(wave.id, dropId);
    const message = buildDmMessage({
      waveName: wave.name,
      authorHandle,
      preview,
      dropUrl
    });

    const fallbackProfile = authorProfile ?? null;

    for (const subscriberId of subscriberIds) {
      if (subscriberId === senderProfile.id) {
        continue;
      }
      await this.sendDmToSubscriber({
        senderProfile,
        fallbackProfile,
        subscriberId,
        message
      }).catch((error) => {
        logger.error(
          `[WAVE DM NOTIFICATION ERROR] [SUBSCRIBER ${subscriberId}] [WAVE ${wave.id}] [${error}]`
        );
      });
    }
  }

  private async sendDmToSubscriber({
    senderProfile,
    fallbackProfile,
    subscriberId,
    message
  }: {
    senderProfile: ApiIdentity;
    fallbackProfile: ApiIdentity | null;
    subscriberId: string;
    message: string;
  }): Promise<void> {
    const subscriberProfile = await identityFetcher
      .getIdentityAndConsolidationsByIdentityKey(
        { identityKey: subscriberId },
        { timer: undefined, authenticationContext: undefined as any }
      )
      .catch(() => null);
    if (!subscriberProfile) {
      logger.warn(`[SKIPPING WAVE DM] [SUBSCRIBER ${subscriberId} NOT FOUND]`);
      return;
    }
    const subscriberWallet = subscriberProfile.primary_wallet;
    if (!subscriberWallet) {
      logger.warn(
        `[SKIPPING WAVE DM] [SUBSCRIBER ${subscriberId} HAS NO WALLET]`
      );
      return;
    }

    try {
      await this.postDmDrop(senderProfile, subscriberWallet, message);
    } catch (error) {
      if (fallbackProfile && fallbackProfile.id !== senderProfile.id) {
        logger.warn(
          `[WAVE DM] [BOT SEND FAILED FOR SUBSCRIBER ${subscriberId}, RETRYING WITH AUTHOR ${fallbackProfile.id}] [${error}]`
        );
        try {
          await this.postDmDrop(fallbackProfile, subscriberWallet, message);
          return;
        } catch (retryError) {
          logger.error(
            `[WAVE DM] [AUTHOR FALLBACK ALSO FAILED FOR SUBSCRIBER ${subscriberId}] [${retryError}]`
          );
        }
      }
      throw error;
    }
  }

  private async postDmDrop(
    senderProfile: ApiIdentity,
    subscriberWallet: string,
    message: string
  ): Promise<void> {
    const requestContext: RequestContext = {
      authenticationContext: undefined as any,
      timer: undefined,
      connection: undefined
    };

    const userGroup =
      await this.userGroupsService.findOrCreateDirectMessageGroup(
        senderProfile as any,
        [subscriberWallet],
        requestContext
      );

    const dmWave = await this.waveApiService.findOrCreateDirectMessageWave(
      userGroup,
      requestContext
    );

    const authorIdentity = senderProfile.handle ?? senderProfile.primary_wallet;
    const model: CreateOrUpdateDropModel = {
      drop_id: null,
      wave_id: dmWave.id,
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
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      author_identity: authorIdentity,
      author_id: senderProfile.id,
      drop_type: DropType.CHAT,
      mentioned_groups: [],
      signature: null,
      is_additional_action_promised: null
    };

    await sqlExecutor.executeNativeQueriesInTransaction(
      async (innerConnection) => {
        const { drop_id } = await createOrUpdateDrop.execute(model, false, {
          connection: innerConnection,
          bypassChatLinkRestrictions: true,
          bypassChatSlowModeRestrictions: true
        });
        return drop_id;
      }
    );
  }
}

export const waveDmNotifier = new WaveDmNotifier(
  userGroupsService,
  waveApiService
);
