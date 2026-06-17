import * as Joi from 'joi';
import { PageSortDirection } from '@/api/page-request';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiGlobalRepCategoryGiversPage } from '@/api/generated/models/ApiGlobalRepCategoryGiversPage';
import { ApiGlobalRepCategoryOverview } from '@/api/generated/models/ApiGlobalRepCategoryOverview';
import { ApiGlobalRepCategoryRatingsPage } from '@/api/generated/models/ApiGlobalRepCategoryRatingsPage';
import { ApiGlobalRepCategoryRecipientsPage } from '@/api/generated/models/ApiGlobalRepCategoryRecipientsPage';
import {
  GetGlobalRepCategoryGiversRequest,
  GetGlobalRepCategoryOverviewRequest,
  GetGlobalRepCategoryRatingsRequest,
  GetGlobalRepCategoryRecipientsRequest
} from '@/api/generated/routes/operations';
import {
  GlobalRepCategoryPairOrderBy,
  GlobalRepCategoryProfileOrderBy
} from '@/api/rep-categories/global-rep-category.db';
import { globalRepCategoryApiService } from '@/api/rep-categories/global-rep-category.api.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { REP_CATEGORY_PATTERN } from '@/entities/IAbusivenessDetectionResult';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';

type OverviewParams = {
  readonly category: string;
};

type RatingsParams = OverviewParams & {
  readonly page: number;
  readonly page_size: number;
  readonly order: PageSortDirection;
  readonly order_by: GlobalRepCategoryPairOrderBy;
  readonly search?: string;
};

type ProfileRankingParams = OverviewParams & {
  readonly page: number;
  readonly page_size: number;
  readonly order: PageSortDirection;
  readonly order_by: GlobalRepCategoryProfileOrderBy;
  readonly search?: string;
};

const CategorySchema = Joi.string()
  .max(100)
  .regex(REP_CATEGORY_PATTERN)
  .required();

const OverviewSchema = Joi.object<OverviewParams>({
  category: CategorySchema
});

const RatingsSchema = Joi.object<RatingsParams>({
  category: CategorySchema,
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(200).default(50),
  order: Joi.string()
    .uppercase()
    .valid(PageSortDirection.ASC, PageSortDirection.DESC)
    .default(PageSortDirection.DESC),
  order_by: Joi.string()
    .valid('rep', 'last_modified', 'giver', 'recipient')
    .default('rep'),
  search: Joi.string().trim().max(100).allow('').optional()
});

const ProfileRankingSchema = Joi.object<ProfileRankingParams>({
  category: CategorySchema,
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(200).default(50),
  order: Joi.string()
    .uppercase()
    .valid(PageSortDirection.ASC, PageSortDirection.DESC)
    .default(PageSortDirection.DESC),
  order_by: Joi.string()
    .valid('rep', 'last_modified', 'profile')
    .default('rep'),
  search: Joi.string().trim().max(100).allow('').optional()
});

export async function handleGetGlobalRepCategoryOverview(
  req: GetGlobalRepCategoryOverviewRequest
): Promise<ApiGlobalRepCategoryOverview> {
  const params = getValidatedByJoiOrThrow(
    req.params,
    OverviewSchema
  ) as OverviewParams;
  return globalRepCategoryApiService.getOverview(
    { category: params.category },
    await getRequestContext(req)
  );
}

export async function handleGetGlobalRepCategoryRatings(
  req: GetGlobalRepCategoryRatingsRequest
): Promise<ApiGlobalRepCategoryRatingsPage> {
  const params = getValidatedByJoiOrThrow(
    { ...req.params, ...req.query },
    RatingsSchema
  ) as RatingsParams;
  return globalRepCategoryApiService.getRatings(
    {
      category: params.category,
      page: params.page,
      page_size: params.page_size,
      order: params.order,
      order_by: params.order_by,
      search: normalizeSearch(params.search)
    },
    await getRequestContext(req)
  );
}

export async function handleGetGlobalRepCategoryRecipients(
  req: GetGlobalRepCategoryRecipientsRequest
): Promise<ApiGlobalRepCategoryRecipientsPage> {
  const params = getValidatedByJoiOrThrow(
    { ...req.params, ...req.query },
    ProfileRankingSchema
  ) as ProfileRankingParams;
  return globalRepCategoryApiService.getRecipients(
    {
      category: params.category,
      page: params.page,
      page_size: params.page_size,
      order: params.order,
      order_by: params.order_by,
      search: normalizeSearch(params.search)
    },
    await getRequestContext(req)
  );
}

export async function handleGetGlobalRepCategoryGivers(
  req: GetGlobalRepCategoryGiversRequest
): Promise<ApiGlobalRepCategoryGiversPage> {
  const params = getValidatedByJoiOrThrow(
    { ...req.params, ...req.query },
    ProfileRankingSchema
  ) as ProfileRankingParams;
  return globalRepCategoryApiService.getGivers(
    {
      category: params.category,
      page: params.page,
      page_size: params.page_size,
      order: params.order,
      order_by: params.order_by,
      search: normalizeSearch(params.search)
    },
    await getRequestContext(req)
  );
}

async function getRequestContext(
  req:
    | GetGlobalRepCategoryOverviewRequest
    | GetGlobalRepCategoryRatingsRequest
    | GetGlobalRepCategoryRecipientsRequest
    | GetGlobalRepCategoryGiversRequest
): Promise<RequestContext> {
  const timer = Timer.getFromRequest(req);
  return {
    timer,
    authenticationContext: await getAuthenticationContext(req, timer)
  };
}

function normalizeSearch(search: string | undefined): string | null {
  const trimmed = search?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
