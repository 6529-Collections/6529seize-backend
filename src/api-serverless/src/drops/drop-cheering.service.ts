import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { withLegacyPrimaryMutation } from '@/competitions/legacy-competition-mutation';
import { ForbiddenException } from '@/exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { RequestContext } from '../../../request.context';
import { DropType } from '../../../entities/IDrop';
import {
  voteForDropUseCase,
  VoteForDropUseCase
} from '../../../drops/vote-for-drop.use-case';
import {
  waveQuickVoteDb,
  WaveQuickVoteDb
} from '@/api/waves/wave-quick-vote.db';
import { assertUnreachable } from '../../../assertions';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '../ws/ws-listeners-notifier';
import { DropsApiService, dropsService } from './drops.api.service';
import { reactionsService, ReactionsService } from './reactions.service';
import {
  dropBroadcastCoalescer,
  DropBroadcastCoalescer
} from '@/api/drops/drop-broadcast-coalescer';
import { findCommittedDropOnWriter } from '@/api/drops/drop-writer-read';
import { Logger } from '@/logging';

export class DropCheeringService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropsDb: DropsDb,
    private readonly reactionsService: ReactionsService,
    private readonly voteForDrop: VoteForDropUseCase,
    private readonly waveQuickVoteDb: WaveQuickVoteDb,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly dropsService: DropsApiService,
    private readonly broadcastCoalescer: DropBroadcastCoalescer = dropBroadcastCoalescer
  ) {}

  async updateCheers(
    param: {
      drop_id: string;
      rater_profile_id: string;
      groupIdsUserIsEligibleFor: string[];
      newCheers: number;
    },
    ctx: RequestContext
  ) {
    const drop = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const initial = await this.dropsDb.findDropById(
          param.drop_id,
          connection
        );
        if (!initial)
          throw new NotFoundException(`Drop ${param.drop_id} not found`);
        return withLegacyPrimaryMutation(
          initial.wave_id,
          { ...ctx, connection },
          async (originalPrimary) => {
            const dropId = param.drop_id;
            const memberships =
              await competitionEntryRepository.findDropEntries(dropId, {
                ...ctx,
                connection
              });
            if (
              memberships.some(
                (entry) => entry.competition_id !== originalPrimary?.id
              )
            )
              throw new ForbiddenException(
                'Vote through the competition entry'
              );
            const dropEntity =
              await this.dropsDb.findDropByIdWithEligibilityCheck(
                dropId,
                param.groupIdsUserIsEligibleFor,
                connection
              );
            const ctxWithConnection = { ...ctx, connection };
            if (!dropEntity) {
              throw new NotFoundException(`Drop ${dropId} not found`);
            }
            if (dropEntity.wave_id !== initial.wave_id)
              throw new Error('Drop ownership changed; retry the request');
            const dropType = dropEntity.drop_type;
            switch (dropType) {
              case DropType.CHAT: {
                const reaction = param.newCheers > 0 ? ':+1:' : ':-1:';
                await this.reactionsService.addReaction(
                  dropId,
                  param.rater_profile_id,
                  reaction,
                  ctxWithConnection
                );
                break;
              }
              case DropType.PARTICIPATORY: {
                if (param.newCheers === 0) {
                  await this.waveQuickVoteDb.insertSkip(
                    {
                      identity_id: param.rater_profile_id,
                      wave_id: dropEntity.wave_id,
                      drop_id: dropId
                    },
                    ctxWithConnection
                  );
                  await this.clearSkipsIfRoundCompleted(
                    {
                      identity_id: param.rater_profile_id,
                      wave_id: dropEntity.wave_id
                    },
                    ctxWithConnection
                  );
                }
                const voteChanged = await this.voteForDrop.execute(
                  {
                    drop_id: dropId,
                    voter_id: param.rater_profile_id,
                    votes: param.newCheers,
                    wave_id: dropEntity.wave_id,
                    proxy_id: null
                  },
                  ctxWithConnection
                );
                if (!voteChanged) {
                  return null;
                }
                await this.clearSkipsIfRoundCompleted(
                  {
                    identity_id: param.rater_profile_id,
                    wave_id: dropEntity.wave_id
                  },
                  ctxWithConnection
                );
                break;
              }
              case DropType.COMPETITION:
                throw new ForbiddenException(
                  'Vote through the competition entry'
                );
              case DropType.WINNER: {
                throw new BadRequestException(
                  `This drop has already been declared as winner and doesn't accept new votes`
                );
              }
              default:
                assertUnreachable(dropType);
            }
            return await this.dropsService.findDropByIdOrThrow(
              {
                dropId,
                skipEligibilityCheck: true
              },
              ctxWithConnection
            );
          }
        );
      },
      { isolationLevel: 'READ COMMITTED' }
    );
    if (!drop) {
      return;
    }
    // The rating frame's per-recipient credit_left is still read from the
    // replica, so this wait stays until that lookup moves to the writer.
    await giveReadReplicaTimeToCatchUp();
    const dropId = drop.id;
    // The vote's transaction has ended; nothing after this may use its
    // connection.
    const postCommitCtx: RequestContext = { ...ctx, connection: undefined };
    try {
      await this.broadcastCoalescer.broadcast({
        kind: 'RATING',
        dropId,
        send: async (phase) =>
          this.wsListenersNotifier.notifyAboutDropRatingUpdate(
            phase === 'trailing'
              ? await findCommittedDropOnWriter(
                  { dropId, db: this.dropsDb, dropsService: this.dropsService },
                  postCommitCtx
                )
              : drop,
            postCommitCtx
          )
      });
    } catch (error) {
      // The vote has committed; a failed broadcast must not fail the request.
      this.logger.error(
        `Rating broadcast failed after commit for drop ${dropId}`,
        error
      );
    }
  }

  private async clearSkipsIfRoundCompleted(
    param: { identity_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<void> {
    const nextUndiscoveredDrop =
      await this.waveQuickVoteDb.findNextUndiscoveredDrop(param, ctx);
    if (!nextUndiscoveredDrop) {
      await this.waveQuickVoteDb.clearSkips(param, ctx);
    }
  }
}

export const dropCheeringService = new DropCheeringService(
  dropsDb,
  reactionsService,
  voteForDropUseCase,
  waveQuickVoteDb,
  wsListenersNotifier,
  dropsService
);
