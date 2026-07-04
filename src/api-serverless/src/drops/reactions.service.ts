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
import {
  NewProfileActivityLog,
  profileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
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
import { Logger } from '../../../logging';

type ReactionMutationResult = {
  readonly dropEntity: DropEntity;
  readonly wave: WaveEntity;
  readonly reactionChanged: boolean;
  readonly latestActivityAt: Date | null;
};

type PostCommitSideEffect = {
  readonly name: string;
  readonly run: () => Promise<void>;
};

export class ReactionsService {
  private readonly logger = Logger.get(this.constructor.name);

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

  // Caller-owned transactions keep the legacy all-in-transaction behavior.
  // HTTP reaction routes use the no-connection path so post-commit side effects
  // cannot roll back an already durable reaction.
  private async handleReactionInExistingTransaction(
    dropId: string,
    profileId: string,
    callback: (
      dropEntity: DropEntity,
      groupIdsUserIsEligibleFor: string[]
    ) => Promise<boolean>,
    ctx: RequestContext
  ) {
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        profileId,
        ctx.timer
      );
    const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
      dropId,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );
    if (!dropEntity) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const reactionChanged = await callback(
      dropEntity,
      groupIdsUserIsEligibleFor
    );

    if (reactionChanged) {
      await giveReadReplicaTimeToCatchUp();
    }

    const drop = await this.dropsService.findDropByIdOrThrow(
      {
        dropId: dropId,
        skipEligibilityCheck: true
      },
      ctx
    );

    if (reactionChanged) {
      await this.wsListenersNotifier.notifyAboutDropReactionUpdate(drop, ctx);
    }
    return drop;
  }

  private async handleReactionMutation(
    dropId: string,
    profileId: string,
    callback: (dropEntity: DropEntity) => Promise<{
      wave: WaveEntity;
      reactionChanged: boolean;
      latestActivityAt: Date | null;
    }>,
    ctx: RequestContext
  ): Promise<ReactionMutationResult> {
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        profileId,
        ctx.timer
      );
    const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
      dropId,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );
    if (!dropEntity) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const mutationResult = await callback(dropEntity);
    return {
      dropEntity,
      ...mutationResult
    };
  }

  private async completeReaction(
    dropId: string,
    mutationResult: ReactionMutationResult,
    postCommitSideEffects: PostCommitSideEffect[],
    ctx: RequestContext
  ): Promise<ApiDrop> {
    if (mutationResult.reactionChanged) {
      await giveReadReplicaTimeToCatchUp();
    }

    const drop = await this.dropsService.findDropByIdOrThrow(
      {
        dropId: dropId,
        skipEligibilityCheck: true
      },
      ctx
    );

    if (mutationResult.reactionChanged) {
      await this.runPostCommitSideEffects([
        ...postCommitSideEffects,
        {
          name: 'notify-drop-reaction-update',
          run: () =>
            this.wsListenersNotifier.notifyAboutDropReactionUpdate(drop, ctx)
        }
      ]);
    }
    return drop;
  }

  private async runPostCommitSideEffects(
    sideEffects: PostCommitSideEffect[]
  ): Promise<void> {
    const results = await Promise.allSettled(
      sideEffects.map((sideEffect) => sideEffect.run())
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `Reaction post-commit side effect failed: ${sideEffects[index].name}`,
          result.reason
        );
      }
    });
  }

  private buildReactionActivityLog({
    dropEntity,
    profileId,
    reaction
  }: {
    dropEntity: DropEntity;
    profileId: string;
    reaction: string | null;
  }): NewProfileActivityLog {
    return {
      profile_id: profileId,
      type: ProfileActivityLogType.DROP_REACTED,
      target_id: dropEntity.id,
      contents: JSON.stringify({
        reaction
      }),
      additional_data_1: dropEntity.author_id,
      additional_data_2: dropEntity.wave_id,
      proxy_id: null
    };
  }

  private touchLatestActivitySideEffect(
    profileId: string,
    latestActivityAt: Date | null,
    ctx: RequestContext
  ): PostCommitSideEffect {
    return {
      name: 'touch-profile-latest-activity',
      run: async () => {
        if (latestActivityAt) {
          await profileActivityLogsDb.touchLatestActivity(
            profileId,
            latestActivityAt,
            undefined,
            ctx.timer
          );
        }
      }
    };
  }

  async addReaction(
    dropId: string,
    profileId: string,
    reaction: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    if (ctx.connection) {
      return await this.addReactionInExistingTransaction(
        dropId,
        profileId,
        reaction,
        ctx
      );
    }

    const mutationResult =
      await this.reactionsDb.executeNativeQueriesInTransaction(
        async (connection) =>
          await this.handleReactionMutation(
            dropId,
            profileId,
            async (dropEntity) => {
              const transactionCtx = {
                ...ctx,
                connection
              };
              const wave = await this.validateReaction(
                dropEntity,
                transactionCtx
              );
              const reactionChanged = await this.reactionsDb.addReaction(
                profileId,
                dropId,
                dropEntity.wave_id,
                reaction,
                transactionCtx
              );

              if (!reactionChanged) {
                return { wave, reactionChanged, latestActivityAt: null };
              }

              const latestActivityAt =
                await profileActivityLogsDb.insertLogEntry(
                  this.buildReactionActivityLog({
                    dropEntity,
                    profileId,
                    reaction
                  }),
                  connection,
                  ctx.timer
                );
              return { wave, reactionChanged, latestActivityAt };
            },
            {
              ...ctx,
              connection
            }
          )
      );

    const postCommitSideEffects: PostCommitSideEffect[] = [
      {
        name: 'record-active-identity',
        // Active identity metrics are rollups; do not fail a committed reaction
        // response if this observational write is temporarily unavailable.
        run: () =>
          this.metricsRecorder.recordActiveIdentity(
            { identityId: profileId },
            ctx
          )
      },
      this.touchLatestActivitySideEffect(
        profileId,
        mutationResult.latestActivityAt,
        ctx
      )
    ];

    if (mutationResult.dropEntity.author_id !== profileId) {
      postCommitSideEffects.push({
        name: 'notify-drop-reaction',
        run: () =>
          this.userNotifier.notifyOfDropReaction(
            {
              profile_id: profileId,
              drop_id: dropId,
              drop_author_id: mutationResult.dropEntity.author_id,
              reaction: reaction,
              wave_id: mutationResult.dropEntity.wave_id
            },
            mutationResult.wave.visibility_group_id
          )
      });
    }

    return await this.completeReaction(
      dropId,
      mutationResult,
      postCommitSideEffects,
      ctx
    );
  }

  private async addReactionInExistingTransaction(
    dropId: string,
    profileId: string,
    reaction: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const connection = ctx.connection;
    if (!connection) {
      throw new Error('addReactionInExistingTransaction requires a connection');
    }

    return await this.handleReactionInExistingTransaction(
      dropId,
      profileId,
      async (dropEntity) => {
        const wave = await this.validateReaction(dropEntity, {
          ...ctx,
          connection
        });
        const reactionChanged = await this.reactionsDb.addReaction(
          profileId,
          dropId,
          dropEntity.wave_id,
          reaction,
          { ...ctx, connection }
        );

        if (!reactionChanged) {
          return false;
        }

        await Promise.all([
          this.metricsRecorder.recordActiveIdentity(
            { identityId: profileId },
            ctx
          ),
          profileActivityLogsDb.insert(
            this.buildReactionActivityLog({
              dropEntity,
              profileId,
              reaction
            }),
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
        return true;
      },
      ctx
    );
  }

  async removeReaction(
    dropId: string,
    profileId: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    if (ctx.connection) {
      return await this.removeReactionInExistingTransaction(
        dropId,
        profileId,
        ctx
      );
    }

    const mutationResult =
      await this.reactionsDb.executeNativeQueriesInTransaction(
        async (connection) =>
          await this.handleReactionMutation(
            dropId,
            profileId,
            async (dropEntity) => {
              const transactionCtx = {
                ...ctx,
                connection
              };
              const wave = await this.validateReaction(
                dropEntity,
                transactionCtx
              );
              const reactionChanged = await this.reactionsDb.removeReaction(
                profileId,
                dropId,
                dropEntity.wave_id,
                transactionCtx
              );

              if (!reactionChanged) {
                return { wave, reactionChanged, latestActivityAt: null };
              }

              const latestActivityAt =
                await profileActivityLogsDb.insertLogEntry(
                  this.buildReactionActivityLog({
                    dropEntity,
                    profileId,
                    reaction: null
                  }),
                  connection,
                  ctx.timer
                );
              return { wave, reactionChanged, latestActivityAt };
            },
            {
              ...ctx,
              connection
            }
          )
      );

    return await this.completeReaction(
      dropId,
      mutationResult,
      [
        this.touchLatestActivitySideEffect(
          profileId,
          mutationResult.latestActivityAt,
          ctx
        )
      ],
      ctx
    );
  }

  private async removeReactionInExistingTransaction(
    dropId: string,
    profileId: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const connection = ctx.connection;
    if (!connection) {
      throw new Error(
        'removeReactionInExistingTransaction requires a connection'
      );
    }

    return await this.handleReactionInExistingTransaction(
      dropId,
      profileId,
      async (dropEntity) => {
        await this.validateReaction(dropEntity, {
          ...ctx,
          connection
        });
        const reactionChanged = await this.reactionsDb.removeReaction(
          profileId,
          dropId,
          dropEntity.wave_id,
          { ...ctx, connection }
        );

        if (!reactionChanged) {
          return false;
        }

        await profileActivityLogsDb.insert(
          this.buildReactionActivityLog({
            dropEntity,
            profileId,
            reaction: null
          }),
          connection,
          ctx.timer
        );
        return true;
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
