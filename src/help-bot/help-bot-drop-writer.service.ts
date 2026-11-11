import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from '@/drops/create-or-update-drop.use-case';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { HELP_BOT_HANDLE } from './help-bot.config';
import { filterHelpBotReplyText } from './help-bot-output-filter';
import { Logger } from '@/logging';
import { withHelpBotAuthentication } from './help-bot.auth';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';

export class HelpBotDropWriterService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly createOrUpdateDrop: CreateOrUpdateDropUseCase,
    private readonly dropsDb: DropsDb,
    private readonly dropsService: DropsApiService,
    private readonly wsListenersNotifier: WsListenersNotifier
  ) {}

  public async reply(
    {
      botProfileId,
      waveId,
      replyToDropId,
      interactionId,
      message,
      allowedGroupMentions = []
    }: {
      readonly botProfileId: string;
      readonly waveId: string;
      readonly replyToDropId: string;
      readonly interactionId: string;
      readonly message: string;
      /**
       * Group mention tokens the bot itself appended (the `@devs6529`
       * escalation). Any other group mention is posted as plain text.
       */
      readonly allowedGroupMentions?: readonly string[];
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const botCtx = withHelpBotAuthentication(botProfileId, ctx);
    // Last gate for every bot reply: links only to 6529.io and no group
    // mentions beyond the explicit escalation. User mentions were already
    // checked against the source knowledge by the answerer.
    const content = filterHelpBotReplyText(message, {
      allowedGroupMentions,
      sourceText: null
    });
    const model: CreateOrUpdateDropModel = {
      drop_id: null,
      wave_id: waveId,
      reply_to: {
        drop_id: replyToDropId,
        drop_part_id: 1
      },
      title: null,
      parts: [
        {
          content,
          quoted_drop: null,
          media: [],
          attachments: []
        }
      ],
      referenced_nfts: [],
      // CreateOrUpdateDropUseCase derives @devs6529 group metadata and
      // recipients from part content, so no individual mention is needed.
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [
        {
          data_key: 'help_bot_interaction_id',
          data_value: interactionId
        }
      ],
      author_identity: HELP_BOT_HANDLE,
      author_id: botProfileId,
      drop_type: DropType.CHAT,
      mentioned_groups: [],
      signature: null,
      is_additional_action_promised: null
    };

    const { drop, pendingPushNotificationIds } =
      await this.dropsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const { drop_id, pending_push_notification_ids } =
            await this.createOrUpdateDrop.execute(model, false, {
              timer: ctx.timer,
              connection,
              // The bot is a system author: its replies skip pre-publication
              // review and the posting-allowed check, and carry no media.
              prePublication: { trustedSystem: true },
              // Link-disabled waves only accept CDN/GIF links, so answers
              // with canonical 6529.io help links need this. The content was
              // filtered above, so every remaining link is on 6529.io.
              bypassChatLinkRestrictions: true,
              // Each reply answers one participant drop that already passed
              // slow mode; the bot's own cooldown would otherwise reject the
              // answer to a second participant after the model work is done.
              // Volume is bounded by the per-wave daily answer limit.
              bypassChatSlowModeRestrictions: true
            });
          await this.dropsDb.updateHideLinkPreview(
            { drop_id, hide_link_preview: true },
            { timer: ctx.timer, connection }
          );
          const apiDrop = await this.dropsService.findDropByIdOrThrow(
            {
              dropId: drop_id,
              skipEligibilityCheck: true
            },
            {
              timer: ctx.timer,
              connection,
              authenticationContext: botCtx.authenticationContext
            }
          );
          return {
            drop: apiDrop,
            pendingPushNotificationIds: pending_push_notification_ids
          };
        }
      );

    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [waveId],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      ctx
    );
    void this.sendPendingPushNotifications({
      dropId: drop.id,
      pendingPushNotificationIds
    });
    await this.wsListenersNotifier.notifyAboutDropUpdate(drop, {
      ...botCtx
    });
    return drop;
  }

  private async sendPendingPushNotifications({
    dropId,
    pendingPushNotificationIds
  }: {
    readonly dropId: string;
    readonly pendingPushNotificationIds: number[];
  }): Promise<void> {
    try {
      await sendIdentityPushNotifications(pendingPushNotificationIds);
    } catch (error) {
      this.logger.error(
        `Failed to send help bot reply push notifications for drop ${dropId}`,
        error
      );
    }
  }
}

export const helpBotDropWriterService = new HelpBotDropWriterService(
  createOrUpdateDrop,
  dropsDb,
  dropsService,
  wsListenersNotifier
);
