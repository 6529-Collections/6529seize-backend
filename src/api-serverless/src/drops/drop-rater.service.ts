import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { ratingsService, RatingsService } from '../../../rates/ratings.service';
import { ratingsDb, RatingsDb } from '../../../rates/ratings.db';
import { RateMatter } from '../../../entities/IRating';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';

class DropRaterService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly ratingsService: RatingsService,
    private readonly ratingsDb: RatingsDb
  ) {}

  async updateRating(param: {
    drop_id: string;
    rater_profile_id: string;
    rating: number;
    category: string;
  }) {
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      await this.ratingsDb.lockRatingsOnMatterForUpdate(
        {
          rater_profile_id: param.rater_profile_id,
          matter: RateMatter.DROP_RATING
        },
        connection
      );
      const dropId = param.drop_id;
      const dropEntity = await this.dropsDb.findDropById(dropId, connection);
      if (!dropEntity) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }
      if (dropEntity.author_id === param.rater_profile_id) {
        throw new BadRequestException(`You can't rate your own drop`);
      }
      const tdhLeftForRep = await this.dropsDb.findCreditLeftForDropsForProfile(
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
            credit_spent: ratingChange
          },
          connection
        );
        await this.ratingsService.updateRatingUnsafe(
          {
            rater_profile_id: param.rater_profile_id,
            matter_target_id: dropId.toString(),
            rating: newRating,
            matter_category: param.category,
            matter: RateMatter.DROP_RATING
          },
          'USER_EDIT',
          connection,
          true
        );
      }
    });
    await giveReadReplicaTimeToCatchUp();
  }
}

export const dropRaterService = new DropRaterService(
  dropsDb,
  ratingsService,
  ratingsDb
);
