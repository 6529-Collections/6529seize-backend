import {
  BotDeviceSigner,
  botDeviceSigner,
  CommittedDropSignatures,
  signedBodyOfDropModel
} from '@/api/device-signing/bot-device-signer';
import { inSequence } from '@/db/in-sequence';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from '@/drops/create-or-update-drop.use-case';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { MEMES_DEPLOYER } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';

export class DeployerDropper {
  constructor(
    private readonly createDrop: CreateOrUpdateDropUseCase,
    private readonly botSigner: BotDeviceSigner = botDeviceSigner
  ) {}

  /**
   * Posts the message in each wave as the deployer. Inside a caller's
   * transaction (`ctx.connection`), the posts are signed only when the caller
   * passes `signatures` and calls its signCommitted() after the commit;
   * otherwise they stay unsigned.
   */
  async drop(
    params: {
      message: string;
      mentionedUsers?: string[];
      waves: string[];
    },
    ctx: RequestContext,
    signatures?: CommittedDropSignatures
  ): Promise<number[]> {
    if (!ctx.connection) {
      const ownSignatures = new CommittedDropSignatures(this.botSigner);
      const deployerProfileId = await this.deployerProfileId();
      const pendingPushNotificationIds =
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            return await this._drop(
              params,
              { ...ctx, connection },
              ownSignatures,
              deployerProfileId
            );
          }
        );
      await ownSignatures.signCommitted(ctx);
      if (params.waves.length) {
        await waveScoreService.requestWaveScoreRefreshBestEffort(
          params.waves,
          WaveScoreDirtyRefreshReason.DROP_CHANGED,
          ctx
        );
      }
      await sendIdentityPushNotifications(pendingPushNotificationIds);
      return pendingPushNotificationIds;
    } else {
      return this._drop(
        params,
        ctx,
        signatures,
        signatures ? await this.deployerProfileId() : null
      );
    }
  }

  /** Null without a database read when no bot has a device key. */
  private deployerProfileId(): Promise<string | null> {
    return this.botSigner.profileIdOfWallet(MEMES_DEPLOYER);
  }

  private async _drop(
    {
      message,
      waves,
      mentionedUsers
    }: {
      message: string;
      mentionedUsers?: string[];
      waves: string[];
    },
    ctx: RequestContext,
    signatures: CommittedDropSignatures | undefined,
    deployerProfileId: string | null
  ): Promise<number[]> {
    ctx.timer?.start(`${this.constructor.name}->drop`);
    const pendingPushNotificationIds = (
      await inSequence(
        waves.map((waveId: string) => async () => {
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
            mentioned_users:
              mentionedUsers?.map((handle) => ({ handle })) ?? [],
            mentioned_waves: [],
            metadata: [],
            author_identity: MEMES_DEPLOYER,
            drop_type: DropType.CHAT,
            mentioned_groups: [],
            signature: null,
            is_additional_action_promised: null
          };
          const { drop_id, pending_push_notification_ids } =
            await this.createDrop.execute(model, false, {
              timer: ctx.timer,
              connection: ctx.connection!,
              prePublication: { trustedSystem: true },
              bypassChatLinkRestrictions: true,
              bypassChatSlowModeRestrictions: true
            });
          // Signed once the transaction committed, so a rollback leaves no
          // event behind.
          signatures?.add({
            botProfileId: deployerProfileId,
            dropId: drop_id,
            waveId,
            replyToDropId: null,
            body: signedBodyOfDropModel(model)
          });
          return pending_push_notification_ids;
        })
      )
    ).flat();
    ctx.timer?.stop(`${this.constructor.name}->drop`);
    return pendingPushNotificationIds;
  }
}

export const deployerDropper = new DeployerDropper(createOrUpdateDrop);
