import { Request, Response } from 'express';
import * as Joi from 'joi';
import {
  REP_CATEGORY_INVALID_MESSAGE,
  REP_CATEGORY_PATTERN
} from '@/entities/IAbusivenessDetectionResult';
import { RateMatter } from '@/entities/IRating';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { ratingsDb } from '@/rates/ratings.db';
import { ratingsService } from '@/rates/ratings.service';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { abusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { asyncRouter } from '@/api/async.router';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { ApiResponse } from '@/api/api-response';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { ApiChangeWaveRepRating } from '@/api/generated/models/ApiChangeWaveRepRating';
import { ApiWaveRepCategoriesPage } from '@/api/generated/models/ApiWaveRepCategoriesPage';
import { ApiWaveRepContributorsPage } from '@/api/generated/models/ApiWaveRepContributorsPage';
import { ApiWaveRepOverview } from '@/api/generated/models/ApiWaveRepOverview';
import { ApiWaveRepRating } from '@/api/generated/models/ApiWaveRepRating';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { assertWaveAndParentVisibleOrThrow } from '@/api/waves/wave-access.helpers';
import { waveRepOverviewApiService } from '@/api/waves/wave-rep-overview.api.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { ApiRatingWithProfileInfoAndLevelPage } from '@/api/generated/models/ApiRatingWithProfileInfoAndLevelPage';

const router = asyncRouter({ mergeParams: true });

router.get(
  `/ratings/by-rater`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<{ id: string }, any, any, WaveRepRatingsByRaterQuery, any>,
    res: Response<ApiResponse<ApiRatingWithProfileInfoAndLevelPage>>
  ) {
    const timer = Timer.getFromRequest(req);
    const query = getValidatedByJoiOrThrow(
      req.query,
      WaveRepRatingsByRaterQuerySchema
    );
    const authenticationContext = await getAuthenticationContext(req, timer);
    await assertWaveVisible(req.params.id, { authenticationContext, timer });
    const result = await ratingsDb.getRatingsByRatersForMatter({
      given: false,
      profileId: req.params.id,
      matter: RateMatter.WAVE_REP,
      page: query.page,
      page_size: query.page_size,
      order: query.order,
      order_by: query.order_by,
      category: query.category ?? null
    });
    res.send(result as ApiRatingWithProfileInfoAndLevelPage);
  }
);

router.get(
  `/overview`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<{ id: string }, any, any, WaveRepOverviewQueryParams, any>,
    res: Response<ApiResponse<ApiWaveRepOverview>>
  ) {
    const timer = Timer.getFromRequest(req);
    const query = getValidatedByJoiOrThrow(
      req.query,
      WaveRepOverviewQuerySchema
    );
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const response = await waveRepOverviewApiService.getOverview(
      {
        waveId: req.params.id,
        page: query.page,
        page_size: query.page_size
      },
      ctx
    );
    res.send(response);
  }
);

router.get(
  `/categories`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<{ id: string }, any, any, WaveRepCategoriesQueryParams, any>,
    res: Response<ApiResponse<ApiWaveRepCategoriesPage>>
  ) {
    const timer = Timer.getFromRequest(req);
    const query = getValidatedByJoiOrThrow(
      req.query,
      WaveRepCategoriesQuerySchema
    );
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const response = await waveRepOverviewApiService.getCategories(
      {
        waveId: req.params.id,
        page: query.page,
        page_size: query.page_size,
        top_contributors_limit: query.top_contributors_limit
      },
      ctx
    );
    res.send(response);
  }
);

router.get(
  `/categories/:category/contributors`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      { id: string; category: string },
      any,
      any,
      WaveRepContributorsQueryParams,
      any
    >,
    res: Response<ApiResponse<ApiWaveRepContributorsPage>>
  ) {
    const timer = Timer.getFromRequest(req);
    const params = getValidatedByJoiOrThrow(
      { ...req.query, ...req.params },
      WaveRepCategoryContributorsQuerySchema
    );
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const response = await waveRepOverviewApiService.getCategoryContributors(
      {
        waveId: params.id,
        category: params.category,
        page: params.page,
        page_size: params.page_size
      },
      ctx
    );
    res.send(response);
  }
);

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: Request<{ id: string }, any, ApiChangeWaveRepRating, any, any>,
    res: Response<ApiResponse<any>>
  ) {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to give Wave REP`);
    }
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const { amount, category } = getValidatedByJoiOrThrow(
      req.body,
      ChangeWaveRepRatingSchema
    );
    const ctx: RequestContext = { timer, authenticationContext };
    const wave = await assertWaveVisible(req.params.id, ctx);
    if (wave.created_by === authenticatedProfileId) {
      throw new BadRequestException(`Wave creator can not rate their own wave`);
    }
    timer.start(`abusivenessDetection`);
    const proposedCategory = category?.trim() ?? '';
    if (proposedCategory !== '') {
      const abusivenessDetectionResult =
        await abusivenessCheckService.checkRepPhrase(proposedCategory);
      if (abusivenessDetectionResult.status === 'DISALLOWED') {
        throw new BadRequestException(
          abusivenessDetectionResult.explanation ??
            'Given category is not allowed'
        );
      }
    }
    timer.stop(`abusivenessDetection`);
    await ratingsService.updateRating(
      {
        authenticationContext,
        rater_profile_id: authenticatedProfileId,
        matter: RateMatter.WAVE_REP,
        matter_category: proposedCategory,
        matter_target_id: req.params.id,
        rating: amount
      },
      ctx
    );
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [req.params.id],
      WaveScoreDirtyRefreshReason.WAVE_REP_CHANGED,
      ctx
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({});
  }
);

router.get(
  `/rating`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      { id: string },
      any,
      any,
      { readonly from_identity?: string; readonly category?: string },
      any
    >,
    res: Response<ApiResponse<ApiWaveRepRating>>
  ) {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    await assertWaveVisible(req.params.id, { authenticationContext, timer });
    const fromIdentity = req.query.from_identity?.trim() || null;
    const raterProfileId = fromIdentity
      ? await identityFetcher.getProfileIdByIdentityKey(
          { identityKey: fromIdentity },
          { timer, authenticationContext }
        )
      : (authenticationContext.getActingAsId() ?? null);
    if (!raterProfileId) {
      res.send({ rating: 0 });
      return;
    }
    const rating = await ratingsDb.getRatingForMatterTarget({
      rater_profile_id: raterProfileId,
      matter_target_id: req.params.id,
      matter: RateMatter.WAVE_REP,
      category: req.query.category ?? null
    });
    res.send({ rating });
  }
);

async function assertWaveVisible(waveId: string, ctx: RequestContext) {
  const authenticatedProfileId =
    ctx.authenticationContext?.getActingAsId() ?? null;
  const eligibleGroups = authenticatedProfileId
    ? await userGroupsService.getGroupsUserIsEligibleFor(
        authenticatedProfileId,
        ctx.timer
      )
    : [];
  const wave = await wavesApiDb.findWaveById(waveId, ctx.connection);
  if (!wave) {
    throw new NotFoundException(`Wave ${waveId} not found`);
  }
  await assertWaveAndParentVisibleOrThrow({
    wave,
    groupsUserIsEligibleFor: eligibleGroups,
    message: `Wave ${waveId} not found`,
    wavesApiDb,
    ctx
  });
  return wave;
}

const ChangeWaveRepRatingSchema: Joi.ObjectSchema<ApiChangeWaveRepRating> =
  Joi.object({
    amount: Joi.number().integer().required(),
    category: Joi.string().max(100).regex(REP_CATEGORY_PATTERN).messages({
      'string.pattern.base': REP_CATEGORY_INVALID_MESSAGE
    })
  });

const WaveRepOverviewQuerySchema: Joi.ObjectSchema<WaveRepOverviewQueryParams> =
  Joi.object<WaveRepOverviewQueryParams>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(200).optional().default(5)
  });

const WaveRepCategoriesQuerySchema: Joi.ObjectSchema<WaveRepCategoriesQueryParams> =
  Joi.object<WaveRepCategoriesQueryParams>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(100).optional().default(10),
    top_contributors_limit: Joi.number()
      .integer()
      .min(1)
      .max(10)
      .optional()
      .default(5)
  });

const WaveRepCategoryContributorsQuerySchema: Joi.ObjectSchema<WaveRepCategoryContributorsQueryParams> =
  Joi.object<WaveRepCategoryContributorsQueryParams>({
    id: Joi.string().required(),
    category: Joi.string().max(100).regex(REP_CATEGORY_PATTERN).required(),
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(200).optional().default(50)
  });

const WaveRepRatingsByRaterQuerySchema: Joi.ObjectSchema<WaveRepRatingsByRaterQuery> =
  Joi.object<WaveRepRatingsByRaterQuery>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(200).optional().default(50),
    order: Joi.string().valid('ASC', 'DESC').optional().default('DESC'),
    order_by: Joi.string()
      .valid('rating', 'handle', 'last_modified', 'tdh', 'cic')
      .optional()
      .default('rating'),
    category: Joi.string().max(100).regex(REP_CATEGORY_PATTERN).optional()
  });

interface WaveRepOverviewQueryParams {
  readonly page: number;
  readonly page_size: number;
}

interface WaveRepCategoriesQueryParams extends WaveRepOverviewQueryParams {
  readonly top_contributors_limit: number;
}

interface WaveRepContributorsQueryParams {
  readonly page: number;
  readonly page_size: number;
}

interface WaveRepCategoryContributorsQueryParams extends WaveRepContributorsQueryParams {
  readonly id: string;
  readonly category: string;
}

interface WaveRepRatingsByRaterQuery {
  readonly page: number;
  readonly page_size: number;
  readonly order: 'ASC' | 'DESC';
  readonly order_by: string;
  readonly category?: string;
}

export default router;
