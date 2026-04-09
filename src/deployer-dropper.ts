import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from '@/drops/create-or-update-drop.use-case';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { MEMES_DEPLOYER } from '@/constants';
import { DropType } from '@/entities/IDrop';

export class DeployerDropper {
  constructor(private readonly createDrop: CreateOrUpdateDropUseCase) {}

  async drop(
    params: {
      message: string;
      mentionedUsers?: string[];
      waves: string[];
    },
    ctx: RequestContext
  ): Promise<number[]> {
    if (!ctx.connection) {
      const pendingPushNotificationIds =
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            return await this._drop(params, { ...ctx, connection });
          }
        );
      // await sendIdentityPushNotifications(pendingPushNotificationIds);
      return pendingPushNotificationIds;
    } else {
      return this._drop(params, ctx);
    }
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
    ctx: RequestContext
  ): Promise<number[]> {
    ctx.timer?.start(`${this.constructor.name}->drop`);
    (
      await Promise.all(
        waves.map(async (waveId: string) => {
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
            signature: null
          };
          const { pending_push_notification_ids } =
            await this.createDrop.execute(model, false, {
              timer: ctx.timer,
              connection: ctx.connection!
            });
          return pending_push_notification_ids;
        })
      )
    ).flat();
    ctx.timer?.stop(`${this.constructor.name}->drop`);
    return [];
  }
}

export const deployerDropper = new DeployerDropper(createOrUpdateDrop);
