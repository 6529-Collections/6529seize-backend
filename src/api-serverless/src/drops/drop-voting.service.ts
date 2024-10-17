import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { ratingsService, RatingsService } from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Time } from '../../../time';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';
import { RequestContext } from '../../../request.context';
import { DropType } from '../../../entities/IDrop';
import { clappingService, ClappingService } from './clapping.service';

export class DropVotingService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly ratingsService: RatingsService,
    private readonly userNotifier: UserNotifier,
    private readonly clappingService: ClappingService
  ) {}

  async updateVote(
    param: {
      drop_id: string;
      rater_profile_id: string;
      groupIdsUserIsEligibleFor: string[];
      rating: number;
      category: string;
    },
    ctx: RequestContext
  ) {
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      const dropId = param.drop_id;
      const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
        dropId,
        param.groupIdsUserIsEligibleFor,
        connection
      );
      const ctxWithConnection = { ...ctx, connection };
      if (!dropEntity) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }
      if (dropEntity.drop_type === DropType.CHAT) {
        await this.clappingService.clap(
          {
            drop_id: dropId,
            clapper_id: param.rater_profile_id,
            claps: param.rating,
            wave_id: dropEntity.wave_id,
            proxy_id: null
          },
          ctxWithConnection
        );
      } else {
        if (dropEntity.author_id === param.rater_profile_id) {
          throw new BadRequestException(`You can't rate your own drop`);
        }
        const wave = await this.dropsDb.findWaveByIdOrThrow(
          dropEntity.wave_id,
          connection
        );
        if (
          wave.voting_period_start !== null &&
          wave.voting_period_start > Time.currentMillis()
        ) {
          throw new BadRequestException(
            `Voting period for this drop hasn't started`
          );
        }
        if (
          wave.voting_period_end !== null &&
          wave.voting_period_end < Time.currentMillis()
        ) {
          throw new BadRequestException(
            `Voting period for this drop has ended`
          );
        }
        if (
          wave.voting_group_id !== null &&
          !param.groupIdsUserIsEligibleFor.includes(wave.voting_group_id)
        ) {
          throw new BadRequestException(
            `User is not eligible to vote in this wave`
          );
        }
        const tdhLeftForRep =
          await this.dropsDb.findCreditLeftForDropsForProfile(
            {
              profileId: param.rater_profile_id
            },
            connection
          );
        const currentRating =
          await this.ratingsService.getRatesSpentToTargetOnMatterForProfile(
            {
              profile_id: param.rater_profile_id,
              matter_target_id: dropId.toString(),
              matter_category: param.category,
              matter: RateMatter.DROP_RATING
            },
            connection
          );
        const newRating = param.rating;
        const ratingChange = Math.abs(newRating - currentRating);
        if (ratingChange > tdhLeftForRep) {
          throw new BadRequestException(
            `Not enough credit left to rating change to drop ${dropId}. Needed ${ratingChange}, left ${tdhLeftForRep}`
          );
        }
        if (ratingChange !== 0) {
          await this.dropsDb.insertCreditSpentOnDropRates(
            {
              rater_id: param.rater_profile_id,
              drop_id: dropId,
              credit_spent: ratingChange,
              wave_id: wave.id
            },
            connection
          );
          await this.userNotifier.notifyOfDropVote(
            {
              drop_id: dropId,
              drop_author_id: dropEntity.author_id,
              voter_id: param.rater_profile_id,
              vote: newRating,
              wave_id: wave.id
            },
            wave.visibility_group_id,
            connection
          );
          await this.ratingsService.updateRatingUnsafe({
            request: {
              rater_profile_id: param.rater_profile_id,
              matter_target_id: dropId.toString(),
              rating: newRating,
              matter_category: param.category,
              matter: RateMatter.DROP_RATING
            },
            changeReason: 'USER_EDIT',
            proxyContext: null,
            connection: connection,
            skipTdhCheck: true
          });
        }
      }
    });
    await giveReadReplicaTimeToCatchUp();
  }

  public async deleteDropVotes(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropRaterService->deleteDropVotes');
    await Promise.all([
      this.ratingsService.deleteRatingsForMatter(
        {
          matter_target_id: dropId,
          matter: RateMatter.DROP_RATING
        },
        ctx
      ),
      this.clappingService.deleteClaps(dropId, ctx),
      this.dropsDb.deleteDropsCreditSpendings(dropId, ctx)
    ]);
    ctx.timer?.stop('dropRaterService->deleteDropVotes');
  }
}

export const dropRaterService = new DropVotingService(
  dropsDb,
  ratingsService,
  userNotifier,
  clappingService
);
