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
import { Logger } from '@/logging';
import { withHelpBotAuthentication } from './help-bot.auth';

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
      mentionedHandles = []
    }: {
      readonly botProfileId: string;
      readonly waveId: string;
      readonly replyToDropId: string;
      readonly interactionId: string;
      readonly message: string;
      readonly mentionedHandles?: string[];
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const botCtx = withHelpBotAuthentication(botProfileId, ctx);
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
          content: message,
          quoted_drop: null,
          media: [],
          attachments: []
        }
      ],
      referenced_nfts: [],
      mentioned_users: mentionedHandles.map((handle) => ({ handle })),
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
              bypassChatLinkRestrictions: true,
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
