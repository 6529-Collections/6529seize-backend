import {
  readCommitted,
  runWriteTransaction
} from '@/api/write-transaction-budget';
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

/**
 * What a committed rating changed: the drop, and the reaction a chat drop's
 * rating becomes (applied after commit). Null when nothing changed.
 */
type CheerOutcome = { dropId: string; reaction: string | null } | null;

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
    // Nothing inside this transaction reads the drop back: the response read
    // overlaps statements on the connection, which the write budget rejects
    // (and would then rerun the whole vote unbudgeted). The drop is read on
    // the writer after commit instead.
    const outcome = await runWriteTransaction((options) =>
      this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
        const initial = await this.dropsDb.findDropById(
          param.drop_id,
          connection
        );
        if (!initial)
          throw new NotFoundException(`Drop ${param.drop_id} not found`);
        return withLegacyPrimaryMutation(
          initial.wave_id,
          { ...ctx, connection },
          async (originalPrimary): Promise<CheerOutcome> => {
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
              throw new ForbiddenException('Vote through the decision entry');
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
              case DropType.CHAT:
                // A rating on a chat drop is the rater's +1/-1 reaction. It
                // runs after this transaction, through the reaction path's own
                // budgeted transaction and its post-commit read and broadcast.
                return {
                  dropId,
                  reaction: param.newCheers > 0 ? ':+1:' : ':-1:'
                };
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
                throw new ForbiddenException('Vote through the decision entry');
              case DropType.WINNER: {
                throw new BadRequestException(
                  `This drop has already been declared as winner and doesn't accept new votes`
                );
              }
              default:
                assertUnreachable(dropType);
            }
            return { dropId, reaction: null };
          }
        );
      }, readCommitted(options))
    );
    if (!outcome) {
      return;
    }
    const { dropId } = outcome;
    // The vote's transaction has ended; nothing after this may use its
    // connection.
    const postCommitCtx: RequestContext = { ...ctx, connection: undefined };
    // Awaited here, inside the request: a transaction left running past the
    // response could be frozen with the Lambda while holding row locks. For a
    // chat drop the transaction above wrote nothing, so if this reaction
    // fails (e.g. WRITE_BUSY) the whole rating fails with nothing written and
    // a retry is safe.
    if (outcome.reaction)
      await this.reactionsService.addReaction(
        dropId,
        param.rater_profile_id,
        outcome.reaction,
        postCommitCtx
      );
    // The rating frame's per-recipient credit_left is still read from the
    // replica, so this wait stays until that lookup moves to the writer.
    await giveReadReplicaTimeToCatchUp();
    try {
      await this.broadcastCoalescer.broadcast({
        kind: 'RATING',
        dropId,
        send: async () =>
          this.wsListenersNotifier.notifyAboutDropRatingUpdate(
            await findCommittedDropOnWriter(
              { dropId, db: this.dropsDb, dropsService: this.dropsService },
              postCommitCtx
            ),
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
