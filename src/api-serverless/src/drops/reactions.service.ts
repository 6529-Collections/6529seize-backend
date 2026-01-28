import { RequestContext } from '../../../request.context';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { reactionsDb, ReactionsDb } from './reactions.db';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { profileActivityLogsDb } from '../../../profileActivityLogs/profile-activity-logs.db';
import {
  UserNotifier,
  userNotifier
} from '../../../notifications/user.notifier';
import { DropsApiService, dropsService } from './drops.api.service';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '../ws/ws-listeners-notifier';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { ApiDrop } from '../generated/models/ApiDrop';
import { DropEntity } from '../../../entities/IDrop';
import { WaveEntity } from '../../../entities/IWave';
import {
  metricsRecorder,
  MetricsRecorder
} from '../../../metrics/MetricsRecorder';

export class ReactionsService {
  constructor(
    private readonly reactionsDb: ReactionsDb,
    private readonly wavesDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly userNotifier: UserNotifier,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly dropsService: DropsApiService,
    private readonly metricsRecorder: MetricsRecorder
  ) {}

  private async handleReaction(
    dropId: string,
    profileId: string,
    callback: (
      dropEntity: DropEntity,
      groupIdsUserIsEligibleFor: string[]
    ) => Promise<void>,
    ctx: RequestContext
  ) {
    const groupIdsUserIsEligibleFor =
      await userGroupsService.getGroupsUserIsEligibleFor(profileId, ctx.timer);
    const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
      dropId,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );
    if (!dropEntity) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    await callback(dropEntity, groupIdsUserIsEligibleFor);
    await giveReadReplicaTimeToCatchUp();

    const drop = await this.dropsService.findDropByIdOrThrow(
      {
        dropId: dropId,
        skipEligibilityCheck: true
      },
      ctx
    );

    await this.wsListenersNotifier.notifyAboutDropReactionUpdate(drop, ctx);
    return drop;
  }

  async addReaction(
    dropId: string,
    profileId: string,
    reaction: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    if (!ctx.connection) {
      return await this.reactionsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          return await this.addReaction(dropId, profileId, reaction, {
            ...ctx,
            connection
          });
        }
      );
    }

    const connection = ctx.connection;
    return await this.handleReaction(
      dropId,
      profileId,
      async (dropEntity) => {
        const wave = await this.validateReaction(dropEntity, {
          ...ctx,
          connection
        });
        const reactionPromise = this.reactionsDb.addReaction(
          profileId,
          dropId,
          dropEntity.wave_id,
          reaction,
          { ...ctx, connection }
        );
        await Promise.all([
          reactionPromise,
          this.metricsRecorder.recordActiveIdentity(
            { identityId: profileId },
            ctx
          ),
          profileActivityLogsDb.insert(
            {
              profile_id: profileId,
              type: ProfileActivityLogType.DROP_REACTED,
              target_id: dropId,
              contents: JSON.stringify({
                reaction
              }),
              additional_data_1: dropEntity.author_id,
              additional_data_2: dropEntity.wave_id,
              proxy_id: null
            },
            connection,
            ctx.timer
          ),
          (() =>
            dropEntity.author_id === profileId
              ? Promise.resolve()
              : this.userNotifier.notifyOfDropReaction(
                  {
                    profile_id: profileId,
                    drop_id: dropId,
                    drop_author_id: dropEntity.author_id,
                    reaction: reaction,
                    wave_id: dropEntity.wave_id
                  },
                  wave.visibility_group_id,
                  connection
                ))()
        ]);
      },
      ctx
    );
  }

  async removeReaction(
    dropId: string,
    profileId: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    if (!ctx.connection) {
      return await this.reactionsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          return await this.removeReaction(dropId, profileId, {
            ...ctx,
            connection
          });
        }
      );
    }

    const connection = ctx.connection;
    return await this.handleReaction(
      dropId,
      profileId,
      async (dropEntity) => {
        await this.validateReaction(dropEntity, {
          ...ctx,
          connection
        });
        const reactionPromise = this.reactionsDb.removeReaction(
          profileId,
          dropId,
          dropEntity.wave_id,
          { ...ctx, connection }
        );
        await Promise.all([
          reactionPromise,
          profileActivityLogsDb.insert(
            {
              profile_id: profileId,
              type: ProfileActivityLogType.DROP_REACTED,
              target_id: dropId,
              contents: JSON.stringify({
                reaction: null
              }),
              additional_data_1: dropEntity.author_id,
              additional_data_2: dropEntity.wave_id,
              proxy_id: null
            },
            connection,
            ctx.timer
          )
        ]);
      },
      ctx
    );
  }

  private async validateReaction(
    dropEntity: DropEntity,
    ctx: RequestContext
  ): Promise<WaveEntity> {
    ctx.timer?.start(`${this.constructor.name}->validateDrop`);
    const wave = await this.wavesDb.findById(
      dropEntity.wave_id,
      ctx.connection
    );

    if (!wave) {
      throw new BadRequestException('Wave not found');
    }
    if (!wave.chat_enabled) {
      throw new ForbiddenException(
        'Chatting and reacting is not enabled in this wave'
      );
    }
    ctx.timer?.stop(`${this.constructor.name}->validateDrop`);
    return wave;
  }

  async deleteReactionsByDrop(dropId: string, ctx: RequestContext) {
    await this.reactionsDb.deleteReactionsByDrop(dropId, ctx);
  }

  async deleteReactionsByWave(waveId: string, ctx: RequestContext) {
    await this.reactionsDb.deleteReactionsByWave(waveId, ctx);
  }
}

export const reactionsService = new ReactionsService(
  reactionsDb,
  wavesApiDb,
  dropsDb,
  userGroupsService,
  userNotifier,
  wsListenersNotifier,
  dropsService,
  metricsRecorder
);
