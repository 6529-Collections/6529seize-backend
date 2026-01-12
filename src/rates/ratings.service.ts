import {
  AggregatedRating,
  AggregatedRatingRequest,
  IdentityUpdate,
  OverRateMatter,
  ratingsDb,
  RatingsDb,
  RatingSnapshotRow,
  RatingStats,
  UpdateRatingRequest
} from './ratings.db';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../exceptions';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import { profileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import {
  getMattersWhereTargetIsProfile,
  RateMatter,
  Rating
} from '../entities/IRating';
import { Logger } from '../logging';
import { Time, Timer } from '../time';
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
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';
import { revokeTdhBasedDropWavesOverVotes } from '../drops/participation-drops-over-vote-revocation';
import { appFeatures } from '../app-features';
import { enums } from '../enums';
import { ids } from '../ids';
import { collections } from '../collections';
import { metricsRecorder, MetricsRecorder } from '../metrics/MetricsRecorder';

interface ProxyCreditSpend {
  readonly actionId: string;
  readonly amount: number;
}

interface UpdateRatingInternalResult {
  readonly identityUpdates: IdentityUpdate[];
  readonly proxyCreditSpends: ProxyCreditSpend[];
}

interface UpdateRatingUnsafeResult {
  readonly identityUpdate: IdentityUpdate | null;
  readonly proxyCreditDelta: number;
}

export class RatingsService {
  private readonly logger = Logger.get('RATINGS_SERVICE');

  constructor(
    private readonly ratingsDb: RatingsDb,
    private readonly repService: RepService,
    private readonly eventScheduler: EventScheduler,
    private readonly arweaveFileUploader: ArweaveFileUploader,
    private readonly profileProxiesDb: ProfileProxiesDb,
    private readonly abusivenessCheckService: AbusivenessCheckService,
    private readonly identitiesDb: IdentitiesDb,
    private readonly metricsRecorder: MetricsRecorder
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
    const totalCredit =
      await identitiesDb.getTdhAndXTdhCombinedAndFloored(profile_id);
    return totalCredit - ratesSpent;
  }

  public async updateRating(
    request: UpdateRatingViaApiRequest,
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateRating`);
      return await this.ratingsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const { identityUpdates, proxyCreditSpends } =
            await this.updateRatingInternal(request, {
              ...ctx,
              connection
            });

          if (identityUpdates.length > 0) {
            ctx.timer?.start(
              `${this.constructor.name}->ratingsDb->applyBulkIdentityUpdates`
            );
            await this.ratingsDb.applyBulkIdentityUpdates(
              identityUpdates,
              connection
            );
            ctx.timer?.stop(
              `${this.constructor.name}->ratingsDb->applyBulkIdentityUpdates`
            );
          }
          await this.applyProxyCreditSpends(proxyCreditSpends, ctx.timer);
          const ratorId = request.authenticationContext.getActingAsId();
          if (ratorId) {
            await this.metricsRecorder.recordActiveIdentity(
              { identityId: ratorId },
              { ...ctx, connection }
            );
          }
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateRating`);
    }
  }

  private async updateRatingInternal(
    request: UpdateRatingViaApiRequest,
    ctx: RequestContext
  ): Promise<UpdateRatingInternalResult> {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateRatingInternal`);
      const authenticatedProfileId =
        request.authenticationContext.getActingAsId();
      if (!authenticatedProfileId) {
        throw new ForbiddenException(`Create a profile before you rate`);
      }
      if (!request.authenticationContext.isAuthenticatedAsProxy()) {
        const { identityUpdate } = await this.updateRatingUnsafe({
          request,
          changeReason: 'USER_EDIT',
          proxyContext: null,
          connection: ctx.connection!,
          timer: ctx.timer
        });
        return {
          identityUpdates: identityUpdate ? [identityUpdate] : [],
          proxyCreditSpends: []
        };
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
        const { identityUpdate, proxyCreditDelta } =
          await this.updateRatingUnsafe({
            request,
            changeReason: 'USER_EDIT',
            proxyContext,
            connection: ctx.connection!,
            timer: ctx.timer
          });
        return {
          identityUpdates: identityUpdate ? [identityUpdate] : [],
          proxyCreditSpends:
            proxyCreditDelta > 0
              ? [
                  {
                    actionId: proxyContext.action_id,
                    amount: proxyCreditDelta
                  }
                ]
              : []
        };
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateRatingInternal`);
    }
  }

  public async updateRatingUnsafe({
    request,
    changeReason,
    proxyContext,
    connection,
    skipCreditCheck,
    skipLogCreation,
    timer
  }: {
    request: UpdateRatingRequest;
    changeReason: string;
    proxyContext: RatingProxyContext | null;
    connection: ConnectionWrapper<any>;
    skipCreditCheck?: boolean;
    skipLogCreation?: boolean;
    timer?: Timer;
  }): Promise<UpdateRatingUnsafeResult> {
    try {
      timer?.start(`${this.constructor.name}->updateRatingUnsafe`);
      const profileId = request.rater_profile_id;
      if (
        getMattersWhereTargetIsProfile().includes(request.matter) &&
        request.matter_target_id === profileId
      ) {
        throw new BadRequestException(`User can not rate their own profile`);
      }
      timer?.start(
        `${this.constructor.name}->updateRatingUnsafe->ratinsDb->getRating`
      );
      const currentRating = await this.ratingsDb.getRating(request, connection);
      timer?.stop(
        `${this.constructor.name}->updateRatingUnsafe->ratinsDb->getRating`
      );
      if (currentRating.rating === request.rating) {
        return { identityUpdate: null, proxyCreditDelta: 0 };
      }
      const ratingChange = Math.abs(currentRating.rating - request.rating);
      let proxyCreditDelta = 0;
      if (proxyContext && proxyContext.credit_amount !== null) {
        const creditLeft =
          proxyContext.credit_amount - (proxyContext.credit_spent ?? 0);
        if (creditLeft < ratingChange) {
          throw new BadRequestException(
            `Not enough proxy credit left to rate.`
          );
        }
        proxyCreditDelta = ratingChange;
      }
      if (!skipCreditCheck) {
        const totalCreditSpentOnMatter =
          currentRating.total_credit_spent_on_matter;
        const creditSpentOnThisRequest =
          Math.abs(request.rating) - Math.abs(currentRating.rating);
        const totalCredit =
          await identitiesDb.getTdhAndXTdhCombinedAndFloored(profileId);
        if (totalCreditSpentOnMatter + creditSpentOnThisRequest > totalCredit) {
          throw new BadRequestException(
            `Not enough credit left to spend on this matter. Changing this vote would spend ${creditSpentOnThisRequest}, but profile only has ${
              totalCredit - totalCreditSpentOnMatter
            } left to spend`
          );
        }
      }
      timer?.start(
        `${this.constructor.name}->updateRatingUnsafe->ratinsDb->updateRating`
      );
      const identityUpdate = await this.ratingsDb.updateRating(
        request,
        request.rating - currentRating.rating,
        connection
      );
      timer?.stop(
        `${this.constructor.name}->updateRatingUnsafe->ratinsDb->updateRating`
      );

      timer?.start(
        `${this.constructor.name}->updateRatingUnsafe->scheduleEvents`
      );
      await this.scheduleEvents(request, currentRating, connection);
      timer?.stop(
        `${this.constructor.name}->updateRatingUnsafe->scheduleEvents`
      );
      if (!skipLogCreation) {
        timer?.start(
          `${this.constructor.name}->updateRatingUnsafe->insertLogs`
        );
        await this.insertLogs(
          request,
          currentRating,
          changeReason,
          proxyContext,
          connection
        );
        timer?.stop(`${this.constructor.name}->updateRatingUnsafe->insertLogs`);
      }

      return { identityUpdate, proxyCreditDelta };
    } finally {
      timer?.stop(`${this.constructor.name}->updateRatingUnsafe`);
    }
  }

  private async insertLogs(
    request: UpdateRatingRequest,
    currentRating: Rating,
    changeReason: string,
    proxyContext: RatingProxyContext | null,
    connection: ConnectionWrapper<any>
  ) {
    await profileActivityLogsDb.insert(
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

  private async applyProxyCreditSpends(
    proxyCreditSpends: ProxyCreditSpend[],
    timer?: Timer
  ) {
    if (proxyCreditSpends.length === 0) {
      return;
    }
    const aggregatedSpends = proxyCreditSpends.reduce(
      (acc, spend) => {
        acc[spend.actionId] = (acc[spend.actionId] ?? 0) + spend.amount;
        return acc;
      },
      {} as Record<string, number>
    );
    const timerLabel = `${this.constructor.name}->profileProxiesDb->checkAndUpdateProxyRatingCredit`;
    timer?.start(timerLabel);
    try {
      for (const [actionId, amount] of Object.entries(aggregatedSpends)) {
        if (amount <= 0) {
          continue;
        }
        try {
          const creditUpdated =
            await this.profileProxiesDb.incrementCreditSpentForAction({
              id: actionId,
              credit_spent_delta: amount
            });
          if (!creditUpdated) {
            this.logger.warn(
              `Best-effort proxy credit spend failed (action=${actionId}, amount=${amount})`
            );
          }
        } catch (error) {
          this.logger.warn(
            `Best-effort proxy credit spend threw (action=${actionId}, amount=${amount}): ${(error as Error).message}`
          );
        }
      }
    } finally {
      timer?.stop(timerLabel);
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
    if (!appFeatures.isUploadCicRepSnaphotsToArweaveEnabled()) {
      return;
    }
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
    this.logger.info('Revoking rates for profiles which have lost credit');
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
      `All rates revoked profiles which have lost credit in ${start.diffFromNow()}`
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
      const coefficient = overRatedMatter.rater_credit / overRatedMatter.tally;
      await this.ratingsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ratings = await this.ratingsDb.getRatingsOnMatter(
            {
              rater_profile_id: raterProfileId,
              matter: overRatedMatter.matter
            },
            connection
          );
          let overCredit =
            Math.abs(overRatedMatter.tally) - overRatedMatter.rater_credit;
          const identityUpdates: IdentityUpdate[] = [];

          for (const rating of ratings) {
            if (rating.rating !== 0) {
              const newRating =
                Math.floor(Math.abs(rating.rating * coefficient)) *
                (rating.rating / Math.abs(rating.rating));
              overCredit =
                overCredit - (Math.abs(rating.rating) - Math.abs(newRating));
              const identityUpdate = await this.insertLostCreditRating(
                rating,
                newRating,
                connection
              );
              if (identityUpdate) {
                identityUpdates.push(identityUpdate);
              }
            }

            if (overCredit <= 0) {
              break;
            }
          }

          if (identityUpdates.length > 0) {
            await this.ratingsDb.applyBulkIdentityUpdates(
              identityUpdates,
              connection
            );
          }
        }
      );
    }
    this.logger.info(`Reduced rates for profile ${raterProfileId}`);
  }

  private async insertLostCreditRating(
    oldRating: Rating,
    newRating: number,
    connection: ConnectionWrapper<any>
  ): Promise<IdentityUpdate | null> {
    const identityUpdate = await this.ratingsDb.updateRating(
      {
        ...oldRating,
        rating: newRating
      },
      newRating - oldRating.rating,
      connection
    );
    await profileActivityLogsDb.insert(
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

    return identityUpdate;
  }

  async deleteRatingsForProfileArchival(
    ratings: Rating[],
    sourceHandle: string,
    targetHandle: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    const identityUpdates: IdentityUpdate[] = [];

    for (const rating of ratings) {
      const { identityUpdate } = await this.updateRatingUnsafe({
        request: {
          ...rating,
          rating: 0
        },
        changeReason: `Profile ${sourceHandle} archived, ratings transferred to ${targetHandle}`,
        proxyContext: null,
        connection: connectionHolder,
        skipLogCreation: true,
        skipCreditCheck: true
      });

      if (identityUpdate) {
        identityUpdates.push(identityUpdate);
      }
    }

    if (identityUpdates.length > 0) {
      await this.ratingsDb.applyBulkIdentityUpdates(
        identityUpdates,
        connectionHolder
      );
    }
  }

  async transferAllGivenProfileRatings(
    sourceProfileId: string,
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    let page = 1;
    const { sourceProfileHandle, targetProfileHandle } = await identitiesDb
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
    const identityUpdates: IdentityUpdate[] = [];

    for (const rating of ratings) {
      const targetRating = await this.ratingsDb.getRating(
        rating,
        connectionHolder
      );

      const { identityUpdate } = await this.updateRatingUnsafe({
        request: { ...rating, rating: rating.rating + targetRating.rating },
        changeReason: `Profile ${sourceHandle} archived, ratings transferred to ${targetHandle}`,
        proxyContext: null,
        connection: connectionHolder,
        skipCreditCheck: true,
        skipLogCreation: true
      });

      if (identityUpdate) {
        identityUpdates.push(identityUpdate);
      }
    }

    if (identityUpdates.length > 0) {
      await this.ratingsDb.applyBulkIdentityUpdates(
        identityUpdates,
        connectionHolder
      );
    }
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
        tdh: it.tdh + it.xtdh,
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
              tdh: result.tdh + result.xtdh,
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
    const resolvedIdentity = await identityFetcher
      .getIdentityAndConsolidationsByIdentityKey({ identityKey: identity }, {})
      .then((it) => {
        if (!it?.id) {
          throw new NotFoundException(`Identity ${identity} not found`);
        }
        return it;
      });
    return {
      profileId: resolvedIdentity.id!,
      wallet: resolvedIdentity.primary_wallet,
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
    const result = await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const actingAsId = authContext.getActingAsId();
        if (!actingAsId) {
          throw new ForbiddenException(`Create a profile before you rate`);
        }
        const matter = enums.resolve(RateMatter, apiRequest.matter)!;
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
                  xtdh: 0,
                  produced_xtdh: 0,
                  granted_xtdh: 0,
                  level_raw: 0,
                  xtdh_rate: 0,
                  basetdh_rate: 0
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
                pfp_url: null
              },
              { connection }
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
        ).reduce(
          (acc, [wallet, { profile }]) => {
            acc[wallet] = profile!.external_id;
            return acc;
          },
          {} as Record<string, string>
        );
        const raterRatingsByTargetProfileId = await this.ratingsDb
          .getRatingsOnMatter(
            {
              rater_profile_id: actingAsId,
              matter
            },
            connection
          )
          .then((result) =>
            result.reduce(
              (acc, it) => {
                if (
                  !apiRequest.category ||
                  it.matter_category == apiRequest.category
                ) {
                  acc[it.matter_target_id] = it.rating;
                }
                return acc;
              },
              {} as Record<string, number>
            )
          );
        const skipped: { identity: string; reason: string }[] = [];
        const ratingChangesByProfileId = Object.entries(
          profileIdsByWallets
        ).reduce(
          (acc, [wallet, profileId]) => {
            if (profileId === authContext.getActingAsId()!) {
              skipped.push({
                identity: wallet,
                reason: `User can't rate themselves`
              });
            } else {
              acc[profileId] = (acc[profileId] ?? 0) + apiRequest.amount_to_add;
            }
            return acc;
          },
          {} as Record<string, number>
        );
        const newRatingsByProfileId = Object.entries(
          ratingChangesByProfileId
        ).reduce(
          (acc, [profileId, ratingChange]) => {
            acc[profileId] =
              (raterRatingsByTargetProfileId[profileId] ?? 0) + ratingChange;
            return acc;
          },
          {} as Record<string, number>
        );
        const allIdentityUpdates: IdentityUpdate[] = [];
        const allProxyCreditSpends: ProxyCreditSpend[] = [];

        for (const [profileId, newRating] of Object.entries(
          newRatingsByProfileId
        )) {
          try {
            const { identityUpdates, proxyCreditSpends } =
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
                { connection }
              );
            allIdentityUpdates.push(...identityUpdates);
            allProxyCreditSpends.push(...proxyCreditSpends);
          } catch (e: any) {
            if (
              e.message.startsWith(
                `Not enough credit left to spend on this matter`
              )
            ) {
              throw new BadRequestException(
                `Not enough credit to go through with this bulk rating`
              );
            }
          }
        }

        if (allIdentityUpdates.length > 0) {
          await this.ratingsDb.applyBulkIdentityUpdates(
            allIdentityUpdates,
            connection
          );
        }
        return { skipped, proxyCreditSpends: allProxyCreditSpends };
      }
    );
    await this.applyProxyCreditSpends(result.proxyCreditSpends);
    return { skipped: result.skipped };
  }

  async getCreditLeft({
    rater_id,
    rater_representative_id
  }: {
    rater_id: string;
    rater_representative_id: string | null;
  }): Promise<ApiAvailableRatingCredit> {
    const totalProfileCredits =
      await identitiesDb.getTdhAndXTdhCombinedAndFloored(rater_id);
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
    let repLeft = totalProfileCredits - repSpent;
    let cicLeft = totalProfileCredits - cicSpent;
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
    const proposedCategories = collections.distinct(
      targets.map((target) => target.category)
    );
    await this.abusivenessCheckService.bulkCheckRepPhrases(
      proposedCategories,
      ctx
    );
    const targetAddresses = collections.distinct(
      targets.map((it) => it.address)
    );
    const proxyCreditSpends =
      await this.identitiesDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const collectedProxyCreditSpends: ProxyCreditSpend[] = [];
          const ctxWithConnection = { ...ctx, connection };
          ctx.timer?.stop(`${this.constructor.name}->bulkRep->createProfiles`);
          const profileIdsByTargetAddresses =
            await profilesService.makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
              targetAddresses,
              ctxWithConnection
            );
          const isRatingItself = Object.values(
            profileIdsByTargetAddresses
          ).find((it) => it === authenticationContext.getActingAsId());
          if (isRatingItself) {
            throw new BadRequestException(`User can't rate themselves`);
          }
          const newRatingsByCategoryAndProfile = targets.reduce(
            (acc, target) => {
              const targetAddress = target.address;
              const targetProfileId =
                profileIdsByTargetAddresses[targetAddress];
              if (targetProfileId) {
                if (!acc[targetProfileId]) {
                  acc[targetProfileId] = {};
                }
                acc[targetProfileId][target.category] =
                  target.amount + (acc[targetProfileId][target.category] ?? 0);
              }
              return acc;
            },
            {} as Record<string, Record<string, number>>
          );
          const ratingChanges = await this.getRatingChanges(
            { newRatingsByCategoryAndProfile, proposedCategories },
            ctxWithConnection
          );
          const creditWastedDuringThisBulkRating = ratingChanges.reduce(
            (acc, { changes }) =>
              acc +
              changes.reduce(
                (cAcc, red) =>
                  cAcc + (Math.abs(red.newRating) - Math.abs(red.oldRating)),
                0
              ),
            0
          );
          const [totalCredit, historicallySpentCredit] = await Promise.all([
            this.identitiesDb.getTdhAndXTdhCombinedAndFloored(
              authenticationContext.getActingAsId()!
            ),
            this.ratingsDb.getTotalCreditSpent(
              RateMatter.REP,
              authenticationContext.getActingAsId()!,
              ctxWithConnection
            )
          ]);
          const creditLeft = totalCredit - historicallySpentCredit;
          if (creditLeft < creditWastedDuringThisBulkRating) {
            throw new BadRequestException(
              `Not enough credit left to go through with this bulk rating`
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
            if (creditLeft < creditWastedDuringThisBulkRating) {
              throw new BadRequestException(
                `Not enough proxy credit left to rate.`
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
            collectedProxyCreditSpends.push({
              actionId: repAction.id,
              amount: creditSpentInThisBulk
            });
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
                id: ids.uniqueShortId(),
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
            profileActivityLogsDb.bulkInsertProfileActivityLogs(
              logs,
              ctxWithConnection
            ),
            this.ratingsDb.bulkUpsertRatings(
              newRatingEntities,
              ctxWithConnection
            )
          ]);
          return collectedProxyCreditSpends;
        }
      );
    await this.applyProxyCreditSpends(proxyCreditSpends, ctx.timer);
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
    ).reduce(
      (acc, [profileId, categoryRatings]) => {
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
      },
      {} as Record<
        string,
        Record<string, { oldRating: number; newRating: number }>
      >
    );
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
  repService,
  eventScheduler,
  arweaveFileUploader,
  profileProxiesDb,
  abusivenessCheckService,
  identitiesDb,
  metricsRecorder
);
