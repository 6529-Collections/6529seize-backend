import {
  AggregatedRating,
  AggregatedRatingRequest,
  OverRateMatter,
  ratingsDb,
  RatingsDb,
  RatingsSearchRequest,
  UpdateRatingRequest
} from './ratings.db';
import { profilesDb, ProfilesDb } from '../profiles/profiles.db';
import { BadRequestException } from '../exceptions';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import { RateMatter, Rating } from '../entities/IRating';
import { Logger } from '../logging';
import { Time } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { Page } from '../api-serverless/src/page-request';
import { ProfilesMatterRating } from './rates.types';
import { tdh2Level } from '../profiles/profile-level';

export interface ProfilesMatterRatingWithRaterLevel
  extends ProfilesMatterRating {
  readonly rater_level: number;
}

export class RatingsService {
  private readonly logger = Logger.get('[RATINGS_SERVICE]');

  constructor(
    private readonly ratingsDb: RatingsDb,
    private readonly profilesDb: ProfilesDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
  ) {}

  public async getAggregatedRatingOnMatter(
    request: AggregatedRatingRequest
  ): Promise<AggregatedRating> {
    return this.ratingsDb.getAggregatedRatingOnMatter(request);
  }

  public async getPageOfRatingsForMatter(
    request: RatingsSearchRequest
  ): Promise<Page<ProfilesMatterRatingWithRaterLevel>> {
    return this.ratingsDb.searchRatingsForMatter(request).then((page) => {
      return {
        ...page,
        data: page.data.map((result) => ({
          ...result,
          rater_level: tdh2Level(result.rater_tdh)
        }))
      };
    });
  }

  public async getRatesLeftOnMatterForProfile({
    profile_id,
    matter
  }: {
    profile_id: string;
    matter: RateMatter;
  }): Promise<number> {
    const ratesSpent = await this.ratingsDb.getRatesSpentOnMatterByProfile({
      profile_id,
      matter
    });
    const tdh = await this.profilesDb.getProfileTdh(profile_id);
    return tdh - ratesSpent;
  }

  public async updateRating(request: UpdateRatingRequest) {
    await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const profileId = request.rater_profile_id;
        const currentRating = await this.ratingsDb.getRatingForUpdate(
          request,
          connection
        );
        const totalTdhSpentOnMatter = currentRating.total_tdh_spent_on_matter;
        const tdhSpentOnThisRequest =
          Math.abs(request.rating) - Math.abs(currentRating.rating);
        const profileTdh = await this.profilesDb.getProfileTdh(profileId);
        if (totalTdhSpentOnMatter + tdhSpentOnThisRequest > profileTdh) {
          throw new BadRequestException(
            `Not enough TDH left to spend on this matter. Changing this vote would spend ${tdhSpentOnThisRequest} TDH, but profile only has ${
              profileTdh - totalTdhSpentOnMatter
            } left to spend`
          );
        }
        await this.ratingsDb.updateRating(request, connection);
        await this.profileActivityLogsDb.insert(
          {
            profile_id: request.rater_profile_id,
            target_id: request.matter_target_id,
            type: ProfileActivityLogType.RATING_EDIT,
            contents: JSON.stringify({
              old_rating: currentRating.rating,
              new_rating: request.rating,
              rating_matter: request.matter,
              rating_category: request.matter_category,
              change_reason: 'USER_EDIT'
            })
          },
          connection
        );
      }
    );
  }

  public async revokeOverRates() {
    const start = Time.now();
    this.logger.info('Revoking rates for profiles which have lost TDH');
    const overRateMatters = await this.ratingsDb.getOverRateMatters();
    const overRateMattersByProfileIds = overRateMatters.reduce(
      (acc, overRateMatter) => {
        if (!acc[overRateMatter.rater_profile_id]) {
          acc[overRateMatter.rater_profile_id] = [];
        }
        acc[overRateMatter.rater_profile_id].push(overRateMatter);
        return acc;
      },
      {} as Record<string, OverRateMatter[]>
    );

    for (const [raterProfileId, profileMatters] of Object.entries(
      overRateMattersByProfileIds
    )) {
      await this.revokeGivenProfileOverRates(raterProfileId, profileMatters);
    }
    this.logger.info(
      `All rates revoked profiles which have lost TDH in ${start.diffFromNow()}`
    );
  }

  private async revokeGivenProfileOverRates(
    raterProfileId: string,
    profileMatters: OverRateMatter[]
  ) {
    this.logger.info(`Revoking rates for profile ${raterProfileId}`);
    for (const overRatedMatter of profileMatters) {
      let runningTdhOver =
        Math.abs(overRatedMatter.tally) - overRatedMatter.rater_tdh;
      for (let page = 1; runningTdhOver > 0; page++) {
        await this.ratingsDb.executeNativeQueriesInTransaction(
          async (connection) => {
            runningTdhOver = await this.handlePageOfOverRates(
              raterProfileId,
              overRatedMatter,
              connection,
              runningTdhOver
            );
          }
        );
      }
    }
    this.logger.info(`Revoked rates for profile ${raterProfileId}`);
  }

  private async handlePageOfOverRates(
    raterProfileId: string,
    overRatedMatter: OverRateMatter,
    connection: ConnectionWrapper<any>,
    runningTdhOver: number
  ) {
    const ratings = await this.ratingsDb.lockNonZeroRatingsNewerFirst(
      {
        rater_profile_id: raterProfileId,
        matter: overRatedMatter.matter,
        page_request: {
          page: 1,
          page_size: 1000
        }
      },
      connection
    );
    if (!ratings.length && runningTdhOver > 0) {
      throw new Error(
        `There are no ratings to revoke, but TDH is still over. rater_profile_id: ${raterProfileId}, matter: ${overRatedMatter.matter}`
      );
    }
    for (const rating of ratings) {
      const ratingValue = rating.rating;
      const sign = ratingValue > 0 ? 1 : -1;
      const counterRating =
        (runningTdhOver - Math.abs(ratingValue) < 0
          ? Math.abs(ratingValue) - runningTdhOver
          : ratingValue) * sign;
      runningTdhOver -= Math.abs(counterRating);
      await this.insertCounterRating(
        rating,
        rating.rating - sign * counterRating,
        connection,
        ratingValue
      );
      if (runningTdhOver <= 0) {
        break;
      }
    }
    return runningTdhOver;
  }

  private async insertCounterRating(
    rating: Rating,
    newRating: number,
    connection: ConnectionWrapper<any>,
    ratingValue: number
  ) {
    await this.ratingsDb.updateRating(
      {
        ...rating,
        rating: newRating
      },
      connection
    );
    await this.profileActivityLogsDb.insert(
      {
        profile_id: rating.rater_profile_id,
        target_id: rating.matter_target_id,
        type: ProfileActivityLogType.RATING_EDIT,
        contents: JSON.stringify({
          old_rating: ratingValue,
          new_rating: newRating,
          rating_matter: rating.matter,
          rating_category: rating.matter_category,
          change_reason: 'LOST_TDH'
        })
      },
      connection
    );
  }
}

export const ratingsService: RatingsService = new RatingsService(
  ratingsDb,
  profilesDb,
  profileActivityLogsDb
);
