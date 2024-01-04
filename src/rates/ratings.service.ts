import {
  AggregatedRating,
  AggregatedRatingRequest,
  RatingWithProfileInfo,
  OverRateMatter,
  ratingsDb,
  RatingsDb,
  RatingsSearchRequest,
  RatingStats,
  UpdateRatingRequest
} from './ratings.db';
import { profilesDb, ProfilesDb } from '../profiles/profiles.db';
import { BadRequestException } from '../exceptions';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import {
  getMattersWhereTargetIsProfile,
  RateMatter,
  Rating
} from '../entities/IRating';
import { Logger } from '../logging';
import { Time } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { Page } from '../api-serverless/src/page-request';
import { ProfilesMatterRating } from './rates.types';
import { calculateLevel } from '../profiles/profile-level';
import { Profile } from '../entities/IProfile';
import {
  repService,
  RepService
} from '../api-serverless/src/profiles/rep.service';

export interface ProfilesMatterRatingWithRaterLevel
  extends ProfilesMatterRating {
  readonly rater_level: number;
}

export class RatingsService {
  private readonly logger = Logger.get('RATINGS_SERVICE');

  constructor(
    private readonly ratingsDb: RatingsDb,
    private readonly profilesDb: ProfilesDb,
    private readonly repService: RepService,
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
    return this.ratingsDb.searchRatingsForMatter(request).then(async (page) => {
      const profileReps = await this.repService.getRepForProfiles(
        page.data.map((it) => it.rater_profile_id)
      );
      return {
        ...page,
        data: page.data.map((result) => ({
          ...result,
          rater_level: calculateLevel({
            tdh: result.rater_tdh,
            rep: profileReps[result.rater_profile_id] ?? 0
          })
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
        await this.updateRatingInternal(request, 'USER_EDIT', connection);
      }
    );
  }

  private async updateRatingInternal(
    request: UpdateRatingRequest,
    changeReason: string,
    connection: ConnectionWrapper<any>,
    skipTdhCheck?: boolean
  ) {
    const profileId = request.rater_profile_id;
    const currentRating = await this.ratingsDb.getRatingForUpdate(
      request,
      connection
    );
    if (!skipTdhCheck) {
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
          change_reason: changeReason
        })
      },
      connection
    );
  }

  public async reduceOverRates() {
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
      await this.reduceGivenProfileOverRates(raterProfileId, profileMatters);
    }
    this.logger.info(
      `All rates revoked profiles which have lost TDH in ${start.diffFromNow()}`
    );
  }

  private async reduceGivenProfileOverRates(
    raterProfileId: string,
    profileMatters: OverRateMatter[]
  ) {
    this.logger.info(`Reducing rates for profile ${raterProfileId}`);
    for (const overRatedMatter of profileMatters) {
      const ratings = await this.ratingsDb.lockRatingsOnMatterForUpdate({
        rater_profile_id: raterProfileId,
        matter: overRatedMatter.matter
      });
      const coefficient = overRatedMatter.rater_tdh / overRatedMatter.tally;
      await this.ratingsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          let overTdh =
            Math.abs(overRatedMatter.tally) - overRatedMatter.rater_tdh;
          for (const rating of ratings) {
            const newRating =
              Math.floor(Math.abs(rating.rating * coefficient)) *
              (rating.rating / Math.abs(rating.rating));
            overTdh = overTdh - (Math.abs(rating.rating) - Math.abs(newRating));
            await this.insertLostTdhRating(rating, newRating, connection);
            if (overTdh <= 0) {
              break;
            }
          }
        }
      );
    }
    this.logger.info(`Reduced rates for profile ${raterProfileId}`);
  }

  private async insertLostTdhRating(
    oldRating: Rating,
    newRating: number,
    connection: ConnectionWrapper<any>
  ) {
    await this.ratingsDb.updateRating(
      {
        ...oldRating,
        rating: newRating
      },
      connection
    );
    await this.profileActivityLogsDb.insert(
      {
        profile_id: oldRating.rater_profile_id,
        target_id: oldRating.matter_target_id,
        type: ProfileActivityLogType.RATING_EDIT,
        contents: JSON.stringify({
          old_rating: oldRating.rating,
          new_rating: newRating,
          rating_matter: oldRating.matter,
          rating_category: oldRating.matter_category,
          change_reason: 'LOST_TDH'
        })
      },
      connection
    );
  }

  async deleteRatingsForProfileArchival(
    ratings: Rating[],
    sourceHandle: string,
    targetHandle: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    for (const rating of ratings) {
      await this.updateRatingInternal(
        {
          ...rating,
          rating: 0
        },
        `Profile ${sourceHandle} archived, ratings transferred to ${targetHandle}`,
        connectionHolder,
        true
      );
    }
  }

  async transferAllGivenProfileRatings(
    sourceProfile: Profile,
    targetProfile: Profile,
    connectionHolder: ConnectionWrapper<any>
  ) {
    let page = 1;
    while (true) {
      const ratings =
        await this.ratingsDb.lockNonZeroRatingsForProfileOlderFirst(
          {
            rater_profile_id: sourceProfile.external_id,
            page_request: {
              page,
              page_size: 1000
            }
          },
          connectionHolder
        );
      await this.deleteRatingsForProfileArchival(
        ratings,
        sourceProfile.handle,
        targetProfile.handle,
        connectionHolder
      );
      await this.insertRatingsAfterProfileArchival(
        ratings
          .map((it) => ({
            ...it,
            rater_profile_id: targetProfile.external_id
          }))
          .filter(
            (it) =>
              !(
                it.matter_target_id === targetProfile.external_id &&
                getMattersWhereTargetIsProfile().includes(it.matter)
              )
          ),
        sourceProfile.handle,
        targetProfile.handle,
        connectionHolder
      );
      if (!ratings.length) {
        break;
      }
      page++;
    }
  }

  async transferAllReceivedProfileRatings(
    sourceProfile: Profile,
    targetProfile: Profile,
    connectionHolder: ConnectionWrapper<any>
  ) {
    let page = 1;
    while (true) {
      const ratings =
        await this.ratingsDb.lockNonZeroRatingsForMatterAndTargetIdOlderFirst(
          {
            matter_target_id: sourceProfile.external_id,
            matters: getMattersWhereTargetIsProfile(),
            page_request: {
              page,
              page_size: 1000
            }
          },
          connectionHolder
        );
      if (!ratings.length) {
        break;
      }
      await this.deleteRatingsForProfileArchival(
        ratings,
        sourceProfile.handle,
        targetProfile.handle,
        connectionHolder
      );
      await this.insertRatingsAfterProfileArchival(
        ratings
          .map((it) => ({
            ...it,
            matter_target_id: targetProfile.external_id
          }))
          .filter(
            (it) =>
              !(
                it.rater_profile_id === targetProfile.external_id &&
                getMattersWhereTargetIsProfile().includes(it.matter)
              )
          ),
        sourceProfile.handle,
        targetProfile.handle,
        connectionHolder
      );
      if (!ratings.length) {
        break;
      }
      page++;
    }
  }

  private async insertRatingsAfterProfileArchival(
    ratings: Rating[],
    sourceHandle: string,
    targetHandle: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    for (const rating of ratings) {
      const targetRating = await this.ratingsDb.getRatingForUpdate(
        rating,
        connectionHolder
      );

      await this.updateRatingInternal(
        { ...rating, rating: rating.rating + targetRating.rating },
        `Profile ${sourceHandle} archived, ratings transferred to ${targetHandle}`,
        connectionHolder,
        true
      );
    }
  }

  async getSummedRatingsOnMatterByTargetIds({
    matter_target_ids,
    matter
  }: {
    matter_target_ids: string[];
    matter: RateMatter;
  }): Promise<Record<string, number>> {
    const results = await this.ratingsDb.getSummedRatingsOnMatterByTargetIds({
      matter_target_ids,
      matter
    });
    return matter_target_ids.reduce((acc, id) => {
      acc[id] = results.find((it) => it.matter_target_id === id)?.rating ?? 0;
      return acc;
    }, {} as Record<string, number>);
  }

  async getAllRatingsForMatterOnProfileGroupedByCategories(param: {
    matter_target_id: string;
    rater_profile_id: string | null;
    matter: RateMatter;
  }): Promise<RatingStats[]> {
    return this.ratingsDb.getRatingStatsOnMatterGroupedByCategories(param);
  }

  async getRatingsForMatterAndCategoryOnProfileWithRatersInfo(param: {
    matter_target_id: string;
    matter_category: string;
    matter: RateMatter;
  }): Promise<RatingWithProfileInfoAndLevel[]> {
    const result =
      await this.ratingsDb.getRatingsForMatterAndCategoryOnProfileWithRatersInfo(
        param
      );
    const profileIds = result.map((it) => it.profile_id);
    const profileReps = await this.repService.getRepForProfiles(profileIds);
    return result.map((it) => ({
      ...it,
      level: calculateLevel({
        tdh: it.tdh,
        rep: profileReps[it.profile_id] ?? 0
      })
    }));
  }

  async getNumberOfRatersForMatterOnProfile(param: {
    matter: RateMatter;
    profile_id: string;
  }): Promise<number> {
    return this.ratingsDb.getNumberOfRatersForMatterOnProfile(param);
  }

  async getRatingsByRatersForMatter(param: {
    given: boolean;
    profileId: string;
    page: number;
    matter: RateMatter;
    page_size: number;
    order: string;
    order_by: string;
  }): Promise<Page<RatingWithProfileInfoAndLevel>> {
    return this.ratingsDb
      .getRatingsByRatersForMatter(param)
      .then(async (page) => {
        const profileIds = page.data.map((it) => it.profile_id);
        const profileReps = await this.repService.getRepForProfiles(profileIds);
        return {
          ...page,
          data: page.data.map((result) => ({
            ...result,
            level: calculateLevel({
              tdh: result.tdh,
              rep: profileReps[result.profile_id] ?? 0
            })
          }))
        };
      });
  }
}

export type RatingWithProfileInfoAndLevel = RatingWithProfileInfo & {
  level: number;
};

export const ratingsService: RatingsService = new RatingsService(
  ratingsDb,
  profilesDb,
  repService,
  profileActivityLogsDb
);
