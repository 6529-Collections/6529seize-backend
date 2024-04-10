import {
  AggregatedRating,
  AggregatedRatingRequest,
  OverRateMatter,
  ratingsDb,
  RatingsDb,
  RatingSnapshotRow,
  RatingStats,
  RatingWithProfileInfo,
  UpdateRatingRequest
} from './ratings.db';
import { profilesDb, ProfilesDb } from '../profiles/profiles.db';
import { BadRequestException, NotFoundException } from '../exceptions';
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
import { FullPageRequest, Page } from '../api-serverless/src/page-request';
import { calculateLevel } from '../profiles/profile-level';
import { Profile } from '../entities/IProfile';
import {
  repService,
  RepService
} from '../api-serverless/src/profiles/rep.service';
import { profilesService } from '../profiles/profiles.service';
import { Request } from 'express';
import { eventScheduler, EventScheduler } from '../events/event.scheduler';
import converter from 'json-2-csv';
import { arweaveFileUploader, ArweaveFileUploader } from '../arweave';
import { RatingsSnapshot } from '../entities/IRatingsSnapshots';
import { dropsDb, DropsDb } from '../drops/drops.db';

export class RatingsService {
  private readonly logger = Logger.get('RATINGS_SERVICE');

  constructor(
    private readonly ratingsDb: RatingsDb,
    private readonly profilesDb: ProfilesDb,
    private readonly repService: RepService,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly eventScheduler: EventScheduler,
    private readonly arweaveFileUploader: ArweaveFileUploader,
    private readonly dropsDb: DropsDb
  ) {}

  public async getAggregatedRatingOnMatter(
    request: AggregatedRatingRequest,
    connection?: ConnectionWrapper<any>
  ): Promise<AggregatedRating> {
    return this.ratingsDb.getAggregatedRatingOnMatter(request, connection);
  }

  public async getRatesSpentToTargetOnMatterForProfile(
    param: {
      matter: RateMatter;
      profile_id: string;
      matter_target_id: string;
      matter_category: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.ratingsDb.getCurrentRatingOnMatterForProfile(param, connection);
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
        await this.updateRatingUnsafe(request, 'USER_EDIT', connection);
      }
    );
  }

  public async updateRatingUnsafe(
    request: UpdateRatingRequest,
    changeReason: string,
    connection: ConnectionWrapper<any>,
    skipTdhCheck?: boolean
  ) {
    const profileId = request.rater_profile_id;
    if (
      getMattersWhereTargetIsProfile().includes(request.matter) &&
      request.matter_target_id === profileId
    ) {
      throw new BadRequestException(`User can not rate their own profile`);
    }
    const currentRating = await this.ratingsDb.getRatingForUpdate(
      request,
      connection
    );
    if (currentRating.rating === request.rating) {
      return;
    }
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
    await this.scheduleEvents(request, currentRating, connection);
    await this.profileActivityLogsDb.insert(
      {
        profile_id: request.rater_profile_id,
        target_id: request.matter_target_id,
        type:
          request.matter === RateMatter.DROP_REP
            ? ProfileActivityLogType.DROP_REP_EDIT
            : ProfileActivityLogType.RATING_EDIT,
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

  private async scheduleEvents(
    request: UpdateRatingRequest,
    currentRating: Rating,
    connection: ConnectionWrapper<any>
  ) {
    if (request.matter === RateMatter.CIC) {
      await this.eventScheduler.scheduleCicRatingChangedEvent(
        {
          rater_profile_id: request.rater_profile_id,
          target_profile_id: request.matter_target_id,
          old_score: currentRating.rating,
          new_score: request.rating
        },
        connection
      );
    } else if (request.matter === RateMatter.REP) {
      await this.eventScheduler.scheduleRepRatingChangedEvent(
        {
          rater_profile_id: request.rater_profile_id,
          target_profile_id: request.matter_target_id,
          category: request.matter_category,
          old_score: currentRating.rating,
          new_score: request.rating
        },
        connection
      );
    }
  }

  private async uploadRatesSnapshotsToArweave(
    connection: ConnectionWrapper<any>
  ) {
    const start = Time.now();
    this.logger.info('Uploading ratings snapshots to Arweave');
    await Promise.all(
      getMattersWhereTargetIsProfile().map((matter) => {
        return this.uploadMatterRatingsToArweave(matter, connection);
      })
    );
    this.logger.info(
      `All ratings snapshots uploaded to Arweave in ${start.diffFromNow()}`
    );
  }

  private async uploadMatterRatingsToArweave(
    matter: RateMatter,
    connection: ConnectionWrapper<any>
  ) {
    const now = Time.now();
    const latestSnaspshot = await this.ratingsDb.getLatestSnapshot(
      matter,
      connection
    );
    if (
      latestSnaspshot &&
      now.minus(Time.millis(latestSnaspshot.snapshot_time)).lt(Time.hours(23))
    ) {
      this.logger.info(
        `Skipping snapshot of ${matter} ratings as there already is a snapshot done in this matter in last 23 hours`
      );
      return;
    }
    let resp: RatingSnapshotRow[];
    switch (matter) {
      case RateMatter.CIC:
        resp = await this.ratingsDb.getSnapshotOfAllCicRatings(connection);
        break;
      case RateMatter.REP:
        resp = await this.ratingsDb.getSnapshotOfAllRepRatings(connection);
        break;
      default:
        throw new Error(
          `Unhandled matter ${matter} in uploadMatterRatingsToArweave`
        );
    }
    const respWithTimes = resp.map((it) => ({
      ...it,
      snapshot_time: now.toMillis()
    }));
    const csv = await converter.json2csvAsync(respWithTimes);
    this.logger.info(`Uploading snapshot of ${matter} ratings to Arweave`);
    const { url } = await this.arweaveFileUploader.uploadFile(
      Buffer.from(csv),
      'text/csv'
    );
    await this.ratingsDb.insertSnapshot(
      {
        rating_matter: matter,
        url,
        snapshot_time: now.toMillis()
      },
      connection
    );
    this.logger.info(`Persisted ${matter} snapshot to Arweave at ${url}`);
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
    await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.uploadRatesSnapshotsToArweave(connection);
      }
    );
  }

  private async reduceGivenProfileOverRates(
    raterProfileId: string,
    profileMatters: OverRateMatter[]
  ) {
    this.logger.info(`Reducing rates for profile ${raterProfileId}`);
    for (const overRatedMatter of profileMatters) {
      const coefficient = overRatedMatter.rater_tdh / overRatedMatter.tally;
      await this.ratingsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ratings = await this.ratingsDb.lockRatingsOnMatterForUpdate(
            {
              rater_profile_id: raterProfileId,
              matter: overRatedMatter.matter
            },
            connection
          );
          let overTdh =
            Math.abs(overRatedMatter.tally) - overRatedMatter.rater_tdh;
          for (const rating of ratings) {
            if (rating.rating !== 0) {
              const newRating =
                Math.floor(Math.abs(rating.rating * coefficient)) *
                (rating.rating / Math.abs(rating.rating));
              overTdh =
                overTdh - (Math.abs(rating.rating) - Math.abs(newRating));
              await this.insertLostTdhRating(rating, newRating, connection);
            }

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
    await this.scheduleEvents(
      {
        matter: oldRating.matter,
        matter_category: oldRating.matter_category,
        matter_target_id: oldRating.matter_target_id,
        rater_profile_id: oldRating.rater_profile_id,
        rating: newRating
      },
      oldRating,
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
      await this.updateRatingUnsafe(
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

      await this.updateRatingUnsafe(
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

  async getRatingsByRatersForMatter({
    queryParams,
    handleOrWallet,
    matter
  }: {
    queryParams: GetProfileRatingsRequest['query'];
    handleOrWallet: string;
    matter: RateMatter;
  }): Promise<Page<RatingWithProfileInfoAndLevel>> {
    const params = await this.getRatingsSearchParamsFromRequest({
      queryParams,
      handleOrWallet,
      matter
    });
    return this.ratingsDb
      .getRatingsByRatersForMatter(params)
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

  private async getRatingsSearchParamsFromRequest({
    queryParams,
    handleOrWallet,
    matter
  }: {
    queryParams: GetProfileRatingsRequest['query'];
    handleOrWallet: string;
    matter: RateMatter;
  }): Promise<GetRatingsByRatersForMatterParams> {
    const given = queryParams.given === 'true';
    const page = queryParams.page ? parseInt(queryParams.page) : 1;
    const page_size = queryParams.page_size
      ? parseInt(queryParams.page_size)
      : 200;
    const order = queryParams.order?.toLowerCase() === 'asc' ? 'asc' : 'desc';
    const order_by =
      queryParams.order_by?.toLowerCase() === 'rating'
        ? 'rating'
        : 'last_modified';
    const profile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet.toLocaleLowerCase()
      );
    const profile_id = profile?.profile?.external_id;
    if (!profile_id) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
    }
    return {
      profileId: profile_id,
      matter,
      given,
      page,
      page_size,
      order,
      order_by
    };
  }

  async getRatingsSnapshotsPage(
    pageRequest: RatingsSnapshotsPageRequest
  ): Promise<Page<RatingsSnapshot>> {
    const [data, count] = await Promise.all([
      this.ratingsDb.getRatingsSnapshots(pageRequest),
      this.ratingsDb.countRatingsSnapshots(pageRequest)
    ]);
    return {
      count,
      data,
      next: count > pageRequest.page_size * pageRequest.page,
      page: pageRequest.page
    };
  }
}

export type GetProfileRatingsRequest = Request<
  {
    handleOrWallet: string;
  },
  any,
  any,
  {
    given?: string;
    page?: string;
    page_size?: string;
    order?: string;
    order_by?: string;
  },
  any
>;

export type GetRatingsByRatersForMatterParams = {
  given: boolean;
  profileId: string;
  page: number;
  matter: RateMatter;
  page_size: number;
  order: string;
  order_by: string;
};

export type RatingWithProfileInfoAndLevel = RatingWithProfileInfo & {
  level: number;
};

export type RatingsSnapshotsPageRequest = FullPageRequest<'snapshot_time'> & {
  matter: RateMatter | null;
};

export const ratingsService: RatingsService = new RatingsService(
  ratingsDb,
  profilesDb,
  repService,
  profileActivityLogsDb,
  eventScheduler,
  arweaveFileUploader,
  dropsDb
);
