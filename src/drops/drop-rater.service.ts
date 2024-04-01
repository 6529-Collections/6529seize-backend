import { BadRequestException, NotFoundException } from '../exceptions';
import { Time } from '../time';
import { RateMatter } from '../entities/IRating';
import { giveReadReplicaTimeToCatchUp } from '../api-serverless/src/api-helpers';
import { dropsDb, DropsDb } from './drops.db';
import { ratingsService, RatingsService } from '../rates/ratings.service';
import { ratingsDb, RatingsDb } from '../rates/ratings.db';
import { TdhSpentOnDropRep } from '../entities/ITdhSpentOnDropRep';
import { Logger } from '../logging';

class DropRaterService {
  private readonly logger = Logger.get(DropRaterService.name);
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly ratingsService: RatingsService,
    private readonly ratingsDb: RatingsDb
  ) {}

  async updateRating(param: {
    drop_id: number;
    rater_profile_id: string;
    rating: number;
    category: string;
  }) {
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      await this.ratingsDb.lockRatingsOnMatterForUpdate(
        {
          rater_profile_id: param.rater_profile_id,
          matter: RateMatter.DROP_REP
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
      const tdhLeftForRep = await this.dropsDb.findRepLeftForDropsForProfile(
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
            matter: RateMatter.DROP_REP
          },
          connection
        );
      const newRating = param.rating;
      const ratingChange = Math.abs(newRating - currentRating);
      if (ratingChange > tdhLeftForRep) {
        throw new BadRequestException(
          `Not enough TDH left to rating change to drop ${dropId}. Needed ${ratingChange}, left ${tdhLeftForRep}`
        );
      }
      if (ratingChange !== 0) {
        await this.dropsDb.insertTdhSpentOnDropRep(
          {
            rater_id: param.rater_profile_id,
            drop_id: dropId,
            tdh_spent: ratingChange
          },
          connection
        );
        await this.ratingsService.updateRatingUnsafe(
          {
            rater_profile_id: param.rater_profile_id,
            matter_target_id: dropId.toString(),
            rating: newRating,
            matter_category: param.category,
            matter: RateMatter.DROP_REP
          },
          'USER_EDIT',
          connection,
          true
        );
      }
    });
    await giveReadReplicaTimeToCatchUp();
  }

  public async revokeOverRates() {
    const start = Time.now();
    this.logger.info(`Starting to revoke drops overrates`);
    await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const overRates = await this.dropsDb.findOverspentRates(
          {
            reservationStartTime: Time.todayUtcMidnight().minusDays(30)
          },
          connection
        );
        const overRatesByRater = Object.values(
          overRates.reduce((acc, overRate) => {
            const raterId = overRate.rater_id;
            if (!acc[raterId]) {
              acc[raterId] = {
                tdhSpentOnDropReps: [],
                rater_id: raterId,
                profile_tdh: overRate.profile_tdh,
                total_reserved_tdh: overRate.total_reserved_tdh
              };
            }
            acc[raterId].tdhSpentOnDropReps.push({
              id: overRate.id,
              rater_id: overRate.rater_id,
              drop_id: overRate.drop_id,
              tdh_spent: overRate.tdh_spent,
              timestamp: overRate.timestamp
            });
            return acc;
          }, {} as Record<string, { tdhSpentOnDropReps: TdhSpentOnDropRep[]; rater_id: string; profile_tdh: number; total_reserved_tdh: number }>)
        );
        for (const {
          tdhSpentOnDropReps,
          rater_id,
          profile_tdh,
          total_reserved_tdh
        } of overRatesByRater) {
          this.logger.info(`Found drop overrates for profile ${rater_id}`);
          const tdhToRevoke = total_reserved_tdh - profile_tdh;
          const coefficient = tdhToRevoke / total_reserved_tdh;
          let tdhRevokeLeft = tdhToRevoke;
          while (tdhRevokeLeft > 0) {
            const tdhSpentOnDropRep = tdhSpentOnDropReps.pop();
            if (!tdhSpentOnDropRep) {
              break;
            }
            const amountOfTdhToReduce = Math.ceil(
              tdhSpentOnDropRep.tdh_spent * coefficient
            );
            const newTdhSpent =
              tdhSpentOnDropRep.tdh_spent - amountOfTdhToReduce;
            tdhRevokeLeft -= newTdhSpent;
            if (newTdhSpent > 0) {
              await this.dropsDb.updateTdhSpentOnDropRep(
                {
                  reservationId: tdhSpentOnDropRep.id,
                  tdh_spent: newTdhSpent
                },
                connection
              );
            } else {
              await this.dropsDb.deleteTdhSpentOnDropRep(
                tdhSpentOnDropRep.id,
                connection
              );
            }
          }
        }
      }
    );
    this.logger.info(`Revoked drops overrates in ${start.diffFromNow()}`);
  }
}

export const dropRaterService = new DropRaterService(
  dropsDb,
  ratingsService,
  ratingsDb
);
