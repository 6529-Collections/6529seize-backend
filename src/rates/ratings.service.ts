import {
  AggregatedRating,
  AggregatedRatingRequest,
  OverRateMatter,
  ratingsDb,
  RatingsDb,
  RatingSnapshotRow,
  RatingStats,
  UpdateRatingRequest
} from './ratings.db';
import { profilesDb, ProfilesDb } from '../profiles/profiles.db';
import { BadRequestException, ForbiddenException } from '../exceptions';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
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
import { AuthenticationContext } from '../auth-context';
import { ProfileProxyActionType } from '../entities/IProfileProxyAction';
import {
  profileProxiesDb,
  ProfileProxiesDb
} from '../profile-proxies/profile-proxies.db';
import { ApiBulkRateRequest } from '../api-serverless/src/generated/models/ApiBulkRateRequest';
import { distinct, resolveEnum, uniqueShortId } from '../helpers';
import { ApiAvailableRatingCredit } from '../api-serverless/src/generated/models/ApiAvailableRatingCredit';
import { ApiRatingWithProfileInfoAndLevel } from '../api-serverless/src/generated/models/ApiRatingWithProfileInfoAndLevel';
import { ApiRatingWithProfileInfoAndLevelPage } from '../api-serverless/src/generated/models/ApiRatingWithProfileInfoAndLevelPage';
import { IdentitiesDb, identitiesDb } from '../identities/identities.db';
import { RequestContext } from '../request.context';
import { ApiBulkRepRequest } from '../api-serverless/src/generated/models/ApiBulkRepRequest';
import {
  abusivenessCheckService,
  AbusivenessCheckService
} from '../profiles/abusiveness-check.service';
import { ProfileRepRatedEventData } from '../events/datatypes/profile-rep-rated.event-data';
import { ProfileClassification } from '../entities/IProfile';
import { revokeTdhBasedDropWavesOverVotes } from '../drops/participation-drops-over-vote-revocation';

export class RatingsService {
  private readonly logger = Logger.get('RATINGS_SERVICE');

  constructor(
    private readonly ratingsDb: RatingsDb,
    private readonly profilesDb: ProfilesDb,
    private readonly repService: RepService,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly eventScheduler: EventScheduler,
    private readonly arweaveFileUploader: ArweaveFileUploader,
    private readonly profileProxiesDb: ProfileProxiesDb,
    private readonly abusivenessCheckService: AbusivenessCheckService,
    private readonly identitiesDb: IdentitiesDb
  ) {}

  public async getAggregatedRatingOnMatter(
    request: AggregatedRatingRequest,
    connection?: ConnectionWrapper<any>
  ): Promise<AggregatedRating> {
    return this.ratingsDb.getAggregatedRatingOnMatter(request, connection);
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

  public async updateRating(
    request: UpdateRatingViaApiRequest
  ): Promise<{ total: number; byUser: number }> {
    return await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.updateRatingInternal(request, connection);
        return await this.ratingsDb.getTotalAndUserRepRatingForCategoryToProfile(
          {
            matter: request.matter,
            from_profile_id: request.rater_profile_id,
            to_profile_id: request.matter_target_id,
            category: request.matter_category
          },
          connection
        );
      }
    );
  }

  private async updateRatingInternal(
    request: UpdateRatingViaApiRequest,
    connection: ConnectionWrapper<any>
  ) {
    const authenticatedProfileId =
      request.authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Create a profile before you rate`);
    }
    if (!request.authenticationContext.isAuthenticatedAsProxy()) {
      await this.updateRatingUnsafe({
        request,
        changeReason: 'USER_EDIT',
        proxyContext: null,
        connection
      });
    } else {
      const action =
        request.matter === RateMatter.REP
          ? request.authenticationContext.activeProxyActions[
              ProfileProxyActionType.ALLOCATE_REP
            ]
          : request.authenticationContext.activeProxyActions[
              ProfileProxyActionType.ALLOCATE_CIC
            ];
      if (!action) {
        throw new ForbiddenException(
          `Proxy is not allowed to give ${request.matter} ratings`
        );
      }
      const proxyContext: RatingProxyContext = {
        authenticatedProfileId:
          request.authenticationContext.authenticatedProfileId!,
        action_id: action.id,
        credit_amount: action.credit_amount,
        credit_spent: action.credit_spent
      };
      await this.updateRatingUnsafe({
        request,
        changeReason: 'USER_EDIT',
        proxyContext,
        connection
      });
    }
  }

  public async updateRatingUnsafe({
    request,
    changeReason,
    proxyContext,
    connection,
    skipTdhCheck,
    skipLogCreation
  }: {
    request: UpdateRatingRequest;
    changeReason: string;
    proxyContext: RatingProxyContext | null;
    connection: ConnectionWrapper<any>;
    skipTdhCheck?: boolean;
    skipLogCreation?: boolean;
  }) {
    const profileId = request.rater_profile_id;
    if (
      getMattersWhereTargetIsProfile().includes(request.matter) &&
      request.matter_target_id === profileId
    ) {
      throw new BadRequestException(`User can not rate their own profile`);
    }
    const currentRating = await this.ratingsDb.getRating(request, connection);
    if (currentRating.rating === request.rating) {
      return;
    }
    if (!skipTdhCheck) {
      const totalTdhSpentOnMatter = currentRating.total_tdh_spent_on_matter;
      const tdhSpentOnThisRequest =
        Math.abs(request.rating) - Math.abs(currentRating.rating);
      if (proxyContext) {
        await this.checkAndUpdateProxyRatingCredit(
          currentRating,
          request,
          proxyContext,
          connection
        );
      }
      const profileTdh = await this.profilesDb.getProfileTdh(profileId);
      if (totalTdhSpentOnMatter + tdhSpentOnThisRequest > profileTdh) {
        throw new BadRequestException(
          `Not enough TDH left to spend on this matter. Changing this vote would spend ${tdhSpentOnThisRequest} TDH, but profile only has ${
            profileTdh - totalTdhSpentOnMatter
          } left to spend`
        );
      }
    }
    await this.ratingsDb.updateRating(
      request,
      request.rating - currentRating.rating,
      connection
    );
    await this.scheduleEvents(request, currentRating, connection);
    if (!skipLogCreation) {
      await this.insertLogs(
        request,
        currentRating,
        changeReason,
        proxyContext,
        connection
      );
    }
  }

  private async insertLogs(
    request: UpdateRatingRequest,
    currentRating: Rating & {
      total_tdh_spent_on_matter: number;
    },
    changeReason: string,
    proxyContext: RatingProxyContext | null,
    connection: ConnectionWrapper<any>
  ) {
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
        }),
        proxy_id: proxyContext?.authenticatedProfileId ?? null,
        additional_data_1: request.matter,
        additional_data_2: request.matter_category
      },
      connection
    );
  }

  private async checkAndUpdateProxyRatingCredit(
    currentRating: Rating & {
      total_tdh_spent_on_matter: number;
    },
    request: UpdateRatingRequest,
    proxyContext: RatingProxyContext,
    connection: ConnectionWrapper<any>
  ) {
    const ratingChange = Math.abs(currentRating.rating - request.rating);
    const creditAmount = proxyContext.credit_amount;
    const creditSpent = proxyContext.credit_spent ?? 0;
    if (creditAmount !== null) {
      const creditLeft = creditAmount - creditSpent;
      if (creditLeft < ratingChange) {
        throw new BadRequestException(
          `Not enough proxy credit left to rate. Needed ${ratingChange}, left ${creditLeft}`
        );
      }
      await this.profileProxiesDb.updateCreditSpentForAction(
        {
          id: proxyContext.action_id,
          credit_spent: creditSpent + ratingChange
        },
        connection
      );
    }
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
        await revokeTdhBasedDropWavesOverVotes(connection);
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
          const ratings = await this.ratingsDb.getRatingsOnMatter(
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
      newRating - oldRating.rating,
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
        }),
        proxy_id: null,
        additional_data_1: oldRating.matter,
        additional_data_2: oldRating.matter_category
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
      await this.updateRatingUnsafe({
        request: {
          ...rating,
          rating: 0
        },
        changeReason: `Profile ${sourceHandle} archived, ratings transferred to ${targetHandle}`,
        proxyContext: null,
        connection: connectionHolder,
        skipLogCreation: true,
        skipTdhCheck: true
      });
    }
  }

  async transferAllGivenProfileRatings(
    sourceProfileId: string,
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    let page = 1;
    const { sourceProfileHandle, targetProfileHandle } = await profilesDb
      .getProfileHandlesByIds([sourceProfileId, targetProfileId], {
        connection: connectionHolder
      })
      .then((results) => {
        return {
          sourceProfileHandle: results[sourceProfileId],
          targetProfileHandle: results[targetProfileId]
        };
      });
    while (true) {
      const ratings =
        await this.ratingsDb.getNonZeroRatingsForProfileOlderFirst(
          {
            rater_profile_id: sourceProfileId,
            page_request: {
              page,
              page_size: 1000
            }
          },
          connectionHolder
        );
      await this.deleteRatingsForProfileArchival(
        ratings,
        sourceProfileHandle,
        targetProfileHandle,
        connectionHolder
      );
      const rrr = ratings
        .map((it) => ({
          ...it,
          rater_profile_id: targetProfileId
        }))
        .filter(
          (it) =>
            !(
              it.matter_target_id === targetProfileId &&
              getMattersWhereTargetIsProfile().includes(it.matter)
            )
        );
      await this.insertRatingsAfterProfileArchival(
        rrr,
        sourceProfileHandle,
        targetProfileHandle,
        connectionHolder
      );
      if (!ratings.length) {
        break;
      }
      page++;
    }
  }

  async transferAllReceivedProfileRatings(
    sourceProfile: string,
    targetProfile: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    let page = 1;
    while (true) {
      const ratings =
        await this.ratingsDb.getNonZeroRatingsForMatterAndTargetIdOlderFirst(
          {
            matter_target_id: sourceProfile,
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
        sourceProfile,
        targetProfile,
        connectionHolder
      );
      await this.insertRatingsAfterProfileArchival(
        ratings
          .map((it) => ({
            ...it,
            matter_target_id: targetProfile
          }))
          .filter(
            (it) =>
              !(
                it.rater_profile_id === targetProfile &&
                getMattersWhereTargetIsProfile().includes(it.matter)
              )
          ),
        sourceProfile,
        targetProfile,
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
      const targetRating = await this.ratingsDb.getRating(
        rating,
        connectionHolder
      );

      await this.updateRatingUnsafe({
        request: { ...rating, rating: rating.rating + targetRating.rating },
        changeReason: `Profile ${sourceHandle} archived, ratings transferred to ${targetHandle}`,
        proxyContext: null,
        connection: connectionHolder,
        skipTdhCheck: true,
        skipLogCreation: true
      });
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
  }): Promise<ApiRatingWithProfileInfoAndLevel[]> {
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
    identity,
    matter
  }: {
    queryParams: GetProfileRatingsRequest['query'];
    identity: string;
    matter: RateMatter;
  }): Promise<ApiRatingWithProfileInfoAndLevelPage> {
    const params = await this.getRatingsSearchParamsFromRequest({
      queryParams,
      identity,
      matter
    });
    if (!params.profileId) {
      return {
        count: 0,
        data: [],
        next: false,
        page: 1
      };
    }
    return this.ratingsDb
      .getRatingsByRatersForMatter({ ...params, profileId: params.profileId })
      .then(async (page) => {
        const profileIds = page.data.map((it) => it.profile_id);
        const profileReps = await this.repService.getRepForProfiles(profileIds);
        return {
          ...page,
          data: page.data.map<ApiRatingWithProfileInfoAndLevel>((result) => ({
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
    identity,
    matter
  }: {
    queryParams: GetProfileRatingsRequest['query'];
    identity: string;
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
    const resolvedIdentity =
      await profilesService.resolveIdentityOrThrowNotFound(identity);
    return {
      profileId: resolvedIdentity.profile_id,
      wallet: resolvedIdentity.wallet,
      matter,
      given,
      page,
      page_size,
      order,
      order_by,
      category: queryParams.category ?? null
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

  async getRepRating(param: {
    rater_profile_id: string | null;
    target_profile_id: string;
    category: string | null;
  }): Promise<number> {
    return this.ratingsDb.getRepRating(param, {});
  }

  async bulkRateProfiles(
    authContext: AuthenticationContext,
    apiRequest: ApiBulkRateRequest
  ): Promise<{ skipped: { identity: string; reason: string }[] }> {
    const errors = await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const actingAsId = authContext.getActingAsId();
        if (!actingAsId) {
          throw new ForbiddenException(`Create a profile before you rate`);
        }
        const matter = resolveEnum(RateMatter, apiRequest.matter)!;
        const wallets = apiRequest.target_wallet_addresses.map((it) =>
          it.toLowerCase()
        );
        let allIdentitiesByAddresses =
          await this.identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
            wallets,
            connection
          );
        await Promise.all(
          wallets
            .filter((wallet) => !allIdentitiesByAddresses[wallet])
            .map((address) =>
              this.identitiesDb.insertIdentity(
                {
                  consolidation_key: address,
                  primary_address: address,
                  profile_id: null,
                  handle: null,
                  normalised_handle: null,
                  banner1: null,
                  banner2: null,
                  pfp: null,
                  classification: null,
                  sub_classification: null,
                  cic: 0,
                  rep: 0,
                  tdh: 0,
                  level_raw: 0
                },
                connection
              )
            )
        );
        allIdentitiesByAddresses =
          await this.identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
            wallets,
            connection
          );

        const identitiesWithoutProfile = Object.values(
          allIdentitiesByAddresses
        ).filter(({ profile }) => !profile);
        const addressesThatNeedNewProfiles = Array.from(
          identitiesWithoutProfile.reduce((acc, { identity }) => {
            acc.add(identity.primary_address);
            return acc;
          }, new Set<string>())
        );
        await Promise.all(
          addressesThatNeedNewProfiles.map((address) =>
            profilesService.createOrUpdateProfileWithGivenTransaction(
              {
                handle: `id-${address}`,
                classification: ProfileClassification.PSEUDONYM,
                sub_classification: null,
                creator_or_updater_wallet: address,
                pfp_uri: null
              },
              connection
            )
          )
        );
        allIdentitiesByAddresses =
          await this.identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
            wallets,
            connection
          );
        const profileIdsByWallets = Object.entries(
          allIdentitiesByAddresses
        ).reduce((acc, [wallet, { profile }]) => {
          acc[wallet] = profile!.external_id;
          return acc;
        }, {} as Record<string, string>);
        const raterRatingsByTargetProfileId = await this.ratingsDb
          .getRatingsOnMatter(
            {
              rater_profile_id: actingAsId,
              matter
            },
            connection
          )
          .then((result) =>
            result.reduce((acc, it) => {
              if (
                !apiRequest.category ||
                it.matter_category == apiRequest.category
              ) {
                acc[it.matter_target_id] = it.rating;
              }
              return acc;
            }, {} as Record<string, number>)
          );
        const skipped: { identity: string; reason: string }[] = [];
        const ratingChangesByProfileId = Object.entries(
          profileIdsByWallets
        ).reduce((acc, [wallet, profileId]) => {
          if (profileId === authContext.getActingAsId()!) {
            skipped.push({
              identity: wallet,
              reason: `User can't rate themselves`
            });
          } else {
            acc[profileId] = (acc[profileId] ?? 0) + apiRequest.amount_to_add;
          }
          return acc;
        }, {} as Record<string, number>);
        const newRatingsByProfileId = Object.entries(
          ratingChangesByProfileId
        ).reduce((acc, [profileId, ratingChange]) => {
          acc[profileId] =
            (raterRatingsByTargetProfileId[profileId] ?? 0) + ratingChange;
          return acc;
        }, {} as Record<string, number>);
        for (const [profileId, newRating] of Object.entries(
          newRatingsByProfileId
        )) {
          try {
            await this.updateRatingInternal(
              {
                matter,
                matter_category:
                  matter === RateMatter.CIC ? 'CIC' : apiRequest.category!,
                matter_target_id: profileId,
                rater_profile_id: actingAsId,
                rating: newRating,
                authenticationContext: authContext
              },
              connection
            );
          } catch (e: any) {
            if (
              e.message.startsWith(
                `Not enough TDH left to spend on this matter`
              )
            ) {
              throw new BadRequestException(
                `Not enough TDH to go through with this bulk rating`
              );
            }
          }
        }
        return skipped;
      }
    );
    return { skipped: errors };
  }

  async getCreditLeft({
    rater_id,
    rater_representative_id
  }: {
    rater_id: string;
    rater_representative_id: string | null;
  }): Promise<ApiAvailableRatingCredit> {
    const currentTdh = await this.profilesDb.getProfileTdh(rater_id);
    const [repSpent, cicSpent] = await Promise.all([
      this.ratingsDb.getRatesSpentOnMatterByProfile({
        profile_id: rater_id,
        matter: RateMatter.REP
      }),
      this.ratingsDb.getRatesSpentOnMatterByProfile({
        profile_id: rater_id,
        matter: RateMatter.CIC
      })
    ]);
    let repLeft = currentTdh - repSpent;
    let cicLeft = currentTdh - cicSpent;
    if (rater_representative_id && rater_representative_id !== rater_id) {
      const proxies =
        await this.profileProxiesDb.findProfileProxiesByGrantorAndGrantee({
          grantor: rater_id,
          grantee: rater_representative_id
        });
      const proxyIds = proxies.map((it) => it.id);
      const proxyActions =
        await this.profileProxiesDb.findActiveProfileProxyActionsByProxyIds({
          proxy_ids: proxyIds
        });
      const repAction = proxyActions.find(
        (action) => action.action_type === ProfileProxyActionType.ALLOCATE_REP
      );
      const cicAction = proxyActions.find(
        (action) => action.action_type === ProfileProxyActionType.ALLOCATE_CIC
      );
      const proxyRepLeft =
        (repAction?.credit_amount ?? 0) - (repAction?.credit_spent ?? 0);
      const proxyCicLeft =
        (cicAction?.credit_amount ?? 0) - (cicAction?.credit_spent ?? 0);
      repLeft = Math.min(repLeft, proxyRepLeft);
      cicLeft = Math.min(cicLeft, proxyCicLeft);
    }
    return {
      rep_credit: repLeft,
      cic_credit: cicLeft
    };
  }

  async bulkRep({ targets }: ApiBulkRepRequest, ctx: RequestContext) {
    const authenticationContext = ctx.authenticationContext!;
    const proposedCategories = distinct(
      targets.map((target) => target.category)
    );
    await this.abusivenessCheckService.bulkCheckRepPhrases(
      proposedCategories,
      ctx
    );
    const targetAddresses = distinct(targets.map((it) => it.address));
    await this.identitiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        ctx.timer?.stop(`${this.constructor.name}->bulkRep->createProfiles`);
        const profileIdsByTargetAddresses =
          await profilesService.makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
            targetAddresses,
            ctxWithConnection
          );
        const isRatingItself = Object.values(profileIdsByTargetAddresses).find(
          (it) => it === authenticationContext.getActingAsId()
        );
        if (isRatingItself) {
          throw new BadRequestException(`User can't rate themselves`);
        }
        const newRatingsByCategoryAndProfile = targets.reduce((acc, target) => {
          const targetAddress = target.address;
          const targetProfileId = profileIdsByTargetAddresses[targetAddress];
          if (targetProfileId) {
            if (!acc[targetProfileId]) {
              acc[targetProfileId] = {};
            }
            acc[targetProfileId][target.category] =
              target.amount + (acc[targetProfileId][target.category] ?? 0);
          }
          return acc;
        }, {} as Record<string, Record<string, number>>);
        const ratingChanges = await this.getRatingChanges(
          { newRatingsByCategoryAndProfile, proposedCategories },
          ctxWithConnection
        );
        const tdhWastedDuringThisBulkRating = ratingChanges.reduce(
          (acc, { changes }) =>
            acc +
            changes.reduce(
              (cAcc, red) =>
                cAcc + (Math.abs(red.newRating) - Math.abs(red.oldRating)),
              0
            ),
          0
        );
        const [totalTdh, historicallyWastedTdh] = await Promise.all([
          this.ratingsDb.getTdh(authenticationContext.getActingAsId()!, ctx),
          this.ratingsDb.getTotalTdhSpent(
            RateMatter.REP,
            authenticationContext.getActingAsId()!,
            ctxWithConnection
          )
        ]);
        const tdhLeft = totalTdh - historicallyWastedTdh;
        if (tdhLeft < tdhWastedDuringThisBulkRating) {
          throw new BadRequestException(
            `Not enough TDH left to go through with this bulk rating`
          );
        }
        if (authenticationContext.isAuthenticatedAsProxy()) {
          const repAction =
            authenticationContext.activeProxyActions[
              ProfileProxyActionType.ALLOCATE_REP
            ];
          if (!repAction) {
            throw new ForbiddenException(
              `Proxy is not allowed to give REP ratings`
            );
          }
          const creditLeft =
            (repAction.credit_amount ?? 0) - (repAction.credit_spent ?? 0);
          if (creditLeft < tdhWastedDuringThisBulkRating) {
            throw new BadRequestException(
              `Not enough proxy credit left to rate. Needed ${tdhWastedDuringThisBulkRating}, left ${creditLeft}`
            );
          }
          const creditSpentInThisBulk = ratingChanges.reduce(
            (acc, { changes }) =>
              acc +
              changes.reduce(
                (cAcc, red) => cAcc + Math.abs(red.newRating - red.oldRating),
                0
              ),
            0
          );
          await this.profileProxiesDb.updateCreditSpentForAction(
            {
              id: repAction.id,
              credit_spent:
                (repAction.credit_spent ?? 0) + creditSpentInThisBulk
            },
            connection
          );
        }
        const now = Time.now().toDate();
        const raterId = ctx.authenticationContext!.getActingAsId()!;
        const newRatingEntities = ratingChanges
          .map<Rating[]>((profileChange) =>
            profileChange.changes.map<Rating>((ratingChange) => ({
              matter: RateMatter.REP,
              matter_category: ratingChange.category,
              matter_target_id: profileChange.profileId,
              rater_profile_id: raterId,
              rating: ratingChange.newRating,
              authenticationContext: ctx.authenticationContext!,
              last_modified: now
            }))
          )
          .flat();
        const logs = ratingChanges
          .map<ProfileActivityLog[]>((profileChange) =>
            profileChange.changes.map<ProfileActivityLog>((ratingChange) => ({
              id: uniqueShortId(),
              created_at: now,
              profile_id: raterId,
              target_id: profileChange.profileId,
              type: ProfileActivityLogType.RATING_EDIT,
              contents: JSON.stringify({
                old_rating: ratingChange.oldRating,
                new_rating: ratingChange.newRating,
                rating_matter: RateMatter.REP,
                rating_category: ratingChange.category,
                change_reason: 'USER_EDIT'
              }),
              proxy_id: authenticationContext.isAuthenticatedAsProxy()
                ? authenticationContext.getLoggedInUsersProfileId()
                : null,
              additional_data_1: RateMatter.REP,
              additional_data_2: ratingChange.category
            }))
          )
          .flat();
        const events = ratingChanges
          .map<ProfileRepRatedEventData[]>((profileChange) =>
            profileChange.changes.map<ProfileRepRatedEventData>(
              (ratingChange) => ({
                rater_profile_id: raterId,
                target_profile_id: profileChange.profileId,
                category: ratingChange.category,
                old_score: ratingChange.oldRating,
                new_score: ratingChange.newRating
              })
            )
          )
          .flat();
        const repBulkUpdates = ratingChanges.map((profileChange) => ({
          profileId: profileChange.profileId,
          newRep: profileChange.changes.reduce(
            (acc, red) => acc - red.oldRating + red.newRating,
            0
          )
        }));
        await Promise.all([
          this.identitiesDb.bulkUpdateReps(repBulkUpdates, ctxWithConnection),
          this.eventScheduler.scheduleBulkRepRatingChangedEvents(
            events,
            connection
          ),
          this.profileActivityLogsDb.bulkInsertProfileActivityLogs(
            logs,
            ctxWithConnection
          ),
          this.ratingsDb.bulkUpsertRatings(newRatingEntities, ctxWithConnection)
        ]);
      }
    );
  }

  private async getRatingChanges(
    {
      newRatingsByCategoryAndProfile,
      proposedCategories
    }: {
      newRatingsByCategoryAndProfile: Record<string, Record<string, number>>;
      proposedCategories: string[];
    },
    ctxWithConnection: RequestContext
  ) {
    const ratingEntities =
      await this.ratingsDb.getAllRepRatingsForTargetsAndCategories(
        {
          targets: Object.keys(newRatingsByCategoryAndProfile),
          categories: proposedCategories
        },
        ctxWithConnection
      );
    const categoryRatingsByProfiles = Object.entries(
      newRatingsByCategoryAndProfile
    ).reduce((acc, [profileId, categoryRatings]) => {
      acc[profileId] = Object.entries(categoryRatings).reduce(
        (accInner, [category, amount]) => {
          const oldRating =
            ratingEntities.find(
              (it) =>
                it.matter_target_id === profileId &&
                it.matter_category === category
            )?.rating ?? 0;
          accInner[category] = {
            oldRating,
            newRating: amount
          };
          return accInner;
        },
        {} as Record<string, { oldRating: number; newRating: number }>
      );
      return acc;
    }, {} as Record<string, Record<string, { oldRating: number; newRating: number }>>);
    return Object.entries(categoryRatingsByProfiles).map(
      ([profileId, changes]) => ({
        profileId,
        changes: Object.entries(changes)
          .filter(([_, it]) => it.oldRating !== it.newRating)
          .map(([category, { oldRating, newRating }]) => ({
            category,
            oldRating,
            newRating
          }))
      })
    );
  }
}

export type GetProfileRatingsRequest = Request<
  {
    identity: string;
  },
  any,
  any,
  {
    given?: string;
    page?: string;
    page_size?: string;
    order?: string;
    order_by?: string;
    category?: string;
  },
  any
>;

export type GetRatingsByRatersForMatterParams = {
  given: boolean;
  profileId: string | null;
  wallet: string;
  page: number;
  matter: RateMatter;
  page_size: number;
  order: string;
  order_by: string;
  category: string | null;
};

export type RatingsSnapshotsPageRequest = FullPageRequest<'snapshot_time'> & {
  matter: RateMatter | null;
};

export interface UpdateRatingViaApiRequest extends UpdateRatingRequest {
  readonly authenticationContext: AuthenticationContext;
}

interface RatingProxyContext {
  readonly authenticatedProfileId: string;
  readonly action_id: string;
  readonly credit_amount: number | null;
  readonly credit_spent: number | null;
}

export const ratingsService: RatingsService = new RatingsService(
  ratingsDb,
  profilesDb,
  repService,
  profileActivityLogsDb,
  eventScheduler,
  arweaveFileUploader,
  profileProxiesDb,
  abusivenessCheckService,
  identitiesDb
);
