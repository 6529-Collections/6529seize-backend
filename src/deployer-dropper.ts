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
  ) {
    if (!ctx.connection) {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await this._drop(params, { ...ctx, connection });
        }
      );
    } else {
      await this._drop(params, ctx);
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
  ) {
    ctx.timer?.start(`${this.constructor.name}->drop`);
    await Promise.all(
      waves.map((waveId: string) => {
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
          mentioned_users: mentionedUsers?.map((handle) => ({ handle })) ?? [],
          mentioned_waves: [],
          metadata: [],
          author_identity: MEMES_DEPLOYER,
          drop_type: DropType.CHAT,
          mentions_all: false,
          signature: null
        };
        return this.createDrop.execute(model, false, {
          timer: ctx.timer,
          connection: ctx.connection!
        });
      })
    );
    ctx.timer?.stop(`${this.constructor.name}->drop`);
  }
}

export const deployerDropper = new DeployerDropper(createOrUpdateDrop);
