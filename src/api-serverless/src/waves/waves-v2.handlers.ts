import { getAuthenticationContext } from '@/api/auth/auth';
import { dropsService } from '@/api/drops/drops.api.service';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiDropsLeaderboardPageV2 } from '@/api/generated/models/ApiDropsLeaderboardPageV2';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { ApiCreateWaveMetadataRequest } from '@/api/generated/models/ApiCreateWaveMetadataRequest';
import { ApiWaveDecisionsPageV2 } from '@/api/generated/models/ApiWaveDecisionsPageV2';
import { ApiWaveDropsFeedV2 } from '@/api/generated/models/ApiWaveDropsFeedV2';
import { ApiWaveMetadata } from '@/api/generated/models/ApiWaveMetadata';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import { ApiWaveOverviewPage } from '@/api/generated/models/ApiWaveOverviewPage';
import { ApiSubwavesSort } from '@/api/generated/models/ApiSubwavesSort';
import { ApiWaveScoreSort } from '@/api/generated/models/ApiWaveScoreSort';
import { ApiWaveVisibilityTier } from '@/api/generated/models/ApiWaveVisibilityTier';
import { ApiWavesOverviewType } from '@/api/generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '@/api/generated/models/ApiWavesPinFilter';
import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import {
  GetWaveDecisionsV2Request,
  GetWaveDropsV2Request,
  GetWaveLeaderboardV2Request,
  GetWavesV2Request,
  CreateWaveMetadataRequest,
  DeleteWaveMetadataRequest,
  GetWaveMetadataRequest,
  GetOfficialWavesRequest,
  ListWaveSubwavesRequest,
  ListWaveCurationDropsV2Request,
  SearchDropsInWaveV2Request
} from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  apiWaveV2Service,
  FindWavesV2Request
} from '@/api/waves/api-wave-v2.service';
import {
  waveDecisionsApiService,
  WaveDecisionsQuery,
  WaveDecisionsQuerySort
} from '@/api/waves/wave-decisions-api.service';
import { waveMetadataApiService } from '@/api/waves/wave-metadata.api.service';
import { LeaderboardParams, LeaderboardSort } from '@/drops/drops.db';
import { enums } from '@/enums';
import { numbers } from '@/numbers';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetWaveDropsV2PathParams = {
  id: string;
};

type WaveMetadataPathParams = {
  id: string;
};

type DeleteWaveMetadataPathParams = {
  id: string;
  metadata_id: number;
};

const GetWaveDropsV2PathParamsSchema: Joi.ObjectSchema<GetWaveDropsV2PathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const WaveMetadataPathParamsSchema: Joi.ObjectSchema<WaveMetadataPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const DeleteWaveMetadataPathParamsSchema: Joi.ObjectSchema<DeleteWaveMetadataPathParams> =
  Joi.object({
    id: Joi.string().required(),
    metadata_id: Joi.number().integer().min(1).required()
  });

const CreateWaveMetadataBodySchema: Joi.ObjectSchema<ApiCreateWaveMetadataRequest> =
  Joi.object<ApiCreateWaveMetadataRequest>({
    data_key: Joi.string().trim().min(1).max(500).required(),
    data_value: Joi.string().min(1).max(8000).required()
  });

type ListWaveCurationDropsV2PathParams = {
  id: string;
  curation_id: string;
};

type ListWaveCurationDropsV2Query = {
  page: number;
  page_size: number;
};

const ListWaveCurationDropsV2PathParamsSchema: Joi.ObjectSchema<ListWaveCurationDropsV2PathParams> =
  Joi.object({
    id: Joi.string().required(),
    curation_id: Joi.string().required()
  });

const ListWaveCurationDropsV2QuerySchema: Joi.ObjectSchema<ListWaveCurationDropsV2Query> =
  Joi.object<ListWaveCurationDropsV2Query>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(100).optional().default(50)
  });

type GetWaveDecisionsV2PathParams = {
  id: string;
};

const GetWaveDecisionsV2PathParamsSchema: Joi.ObjectSchema<GetWaveDecisionsV2PathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetWaveDecisionsV2QuerySchema: Joi.ObjectSchema<
  Omit<WaveDecisionsQuery, 'wave_id'>
> = Joi.object<Omit<WaveDecisionsQuery, 'wave_id'>>({
  page_size: Joi.number().integer().min(1).max(2000).default(100),
  page: Joi.number().integer().min(1).default(1),
  is_additional_action_promised: Joi.boolean().optional().default(null),
  sort_direction: Joi.string()
    .valid(...Object.values(PageSortDirection))
    .default(PageSortDirection.DESC),
  sort: Joi.string()
    .valid(...Object.values(WaveDecisionsQuerySort))
    .default(WaveDecisionsQuerySort.decision_time)
});

type GetWaveLeaderboardV2PathParams = {
  id: string;
};

const GetWaveLeaderboardV2PathParamsSchema: Joi.ObjectSchema<GetWaveLeaderboardV2PathParams> =
  Joi.object({
    id: Joi.string().required()
  });

type ListWaveSubwavesPathParams = {
  id: string;
};

type ListWaveSubwavesQuery = {
  page: number;
  page_size: number;
  sort: ApiSubwavesSort;
};

const ListWaveSubwavesPathParamsSchema: Joi.ObjectSchema<ListWaveSubwavesPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const ListWaveSubwavesQuerySchema: Joi.ObjectSchema<ListWaveSubwavesQuery> =
  Joi.object<ListWaveSubwavesQuery>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(100).optional().default(50),
    sort: Joi.string()
      .valid(...Object.values(ApiSubwavesSort))
      .optional()
      .default(ApiSubwavesSort.Name)
  });

const GetWaveLeaderboardV2QuerySchema: Joi.ObjectSchema<
  Omit<LeaderboardParams, 'wave_id'>
> = Joi.object<Omit<LeaderboardParams, 'wave_id'>>({
  page_size: Joi.number().integer().min(1).max(100).default(50),
  page: Joi.number().integer().min(1).default(1),
  curation_id: Joi.string().optional().default(null),
  unvoted_by_me: Joi.boolean().optional().default(false),
  is_additional_action_promised: Joi.boolean().optional().default(null),
  price_currency: Joi.string().trim().empty('').optional().default(null),
  min_price: Joi.number().min(0).optional().default(null),
  max_price: Joi.number().min(0).optional().default(null),
  sort_direction: Joi.string()
    .valid(...Object.values(PageSortDirection))
    .default(PageSortDirection.ASC),
  sort: Joi.string()
    .valid(...Object.values(LeaderboardSort))
    .default(LeaderboardSort.RANK)
});

type SearchDropsInWaveV2PathParams = {
  waveId: string;
};

type SearchDropsInWaveV2Query = {
  term: string;
  page: number;
  size: number;
};

const SearchDropsInWaveV2PathParamsSchema: Joi.ObjectSchema<SearchDropsInWaveV2PathParams> =
  Joi.object({
    waveId: Joi.string().required()
  });

const SearchDropsInWaveV2QuerySchema: Joi.ObjectSchema<SearchDropsInWaveV2Query> =
  Joi.object<SearchDropsInWaveV2Query>({
    term: Joi.string().min(1).required(),
    size: Joi.number().integer().min(1).max(100).optional().default(20),
    page: Joi.number().integer().min(1).optional().default(1)
  });

export async function handleGetWavesV2(
  req: GetWavesV2Request
): Promise<ApiWaveOverviewPage> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const params = validateWavesV2Params(
    req.query as Partial<FindWavesV2Request>
  );
  return apiWaveV2Service.findWaves(params, {
    authenticationContext,
    timer
  });
}

export async function handleGetOfficialWaves(
  req: GetOfficialWavesRequest
): Promise<ApiWaveOverview[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return apiWaveV2Service.findOfficialWaves({
    authenticationContext,
    timer
  });
}

export async function handleGetWaveMetadata(
  req: GetWaveMetadataRequest
): Promise<ApiWaveMetadata[]> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    WaveMetadataPathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return waveMetadataApiService.list(id, {
    authenticationContext,
    timer
  });
}

export async function handleCreateWaveMetadata(
  req: CreateWaveMetadataRequest
): Promise<ApiWaveMetadata> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    WaveMetadataPathParamsSchema
  );
  const body = getValidatedByJoiOrThrow(req.body, CreateWaveMetadataBodySchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return waveMetadataApiService.create(
    {
      waveId: id,
      dataKey: body.data_key,
      dataValue: body.data_value
    },
    {
      authenticationContext,
      timer
    }
  );
}

export async function handleDeleteWaveMetadata(
  req: DeleteWaveMetadataRequest
): Promise<ApiWaveMetadata> {
  const { id, metadata_id } = getValidatedByJoiOrThrow(
    req.params,
    DeleteWaveMetadataPathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return waveMetadataApiService.delete(
    {
      waveId: id,
      metadataId: metadata_id
    },
    {
      authenticationContext,
      timer
    }
  );
}

export async function handleGetWaveDropsV2(
  req: GetWaveDropsV2Request
): Promise<ApiWaveDropsFeedV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetWaveDropsV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const amount = numbers.parseIntOrNull(String(req.query.limit)) ?? 200;
  const serialNoLimit = req.query.serial_no_limit
    ? numbers.parseIntOrNull(String(req.query.serial_no_limit))
    : null;
  const searchStrategy =
    enums.resolve(ApiDropSearchStrategy, req.query.search_strategy) ??
    ApiDropSearchStrategy.Older;
  const dropType = req.query.drop_type
    ? (enums.resolve(ApiDropType, req.query.drop_type) ?? null)
    : null;

  return apiWaveV2Service.findDropsFeed(
    {
      wave_id: id,
      drop_id: null,
      amount: amount >= 200 || amount < 1 ? 50 : amount,
      serial_no_limit: serialNoLimit,
      search_strategy: searchStrategy,
      drop_type: dropType,
      curation_id: null
    },
    { authenticationContext, timer }
  );
}

export async function handleListWaveCurationDropsV2(
  req: ListWaveCurationDropsV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id, curation_id } = getValidatedByJoiOrThrow(
    req.params,
    ListWaveCurationDropsV2PathParamsSchema
  );
  const { page, page_size } = getValidatedByJoiOrThrow(
    req.query,
    ListWaveCurationDropsV2QuerySchema
  );
  return apiWaveV2Service.findWaveCurationDrops(
    {
      wave_id: id,
      curation_id,
      page,
      page_size
    },
    { authenticationContext, timer }
  );
}

export async function handleGetWaveDecisionsV2(
  req: GetWaveDecisionsV2Request
): Promise<ApiWaveDecisionsPageV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetWaveDecisionsV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const params: WaveDecisionsQuery = {
    wave_id: id,
    ...getValidatedByJoiOrThrow(req.query, GetWaveDecisionsV2QuerySchema)
  };
  return waveDecisionsApiService.searchConcludedWaveDecisionsV2(params, {
    authenticationContext,
    timer
  });
}

export async function handleGetWaveLeaderboardV2(
  req: GetWaveLeaderboardV2Request
): Promise<ApiDropsLeaderboardPageV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetWaveLeaderboardV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const params: LeaderboardParams = {
    wave_id: id,
    ...getValidatedByJoiOrThrow(req.query, GetWaveLeaderboardV2QuerySchema)
  };
  return dropsService.findLeaderboardV2(params, {
    authenticationContext,
    timer
  });
}

export async function handleListWaveSubwaves(
  req: ListWaveSubwavesRequest
): Promise<ApiWaveOverviewPage> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    ListWaveSubwavesPathParamsSchema
  );
  const { page, page_size, sort } = getValidatedByJoiOrThrow(
    req.query,
    ListWaveSubwavesQuerySchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return apiWaveV2Service.findSubwaves(
    {
      wave_id: id,
      page,
      page_size,
      sort
    },
    { authenticationContext, timer }
  );
}

export async function handleSearchDropsInWaveV2(
  req: SearchDropsInWaveV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const { waveId } = getValidatedByJoiOrThrow(
    req.params,
    SearchDropsInWaveV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { term, page, size } = getValidatedByJoiOrThrow(
    req.query,
    SearchDropsInWaveV2QuerySchema
  );
  return apiWaveV2Service.searchDropsContainingPhraseInWave(
    { term, page, size, wave_id: waveId },
    {
      authenticationContext,
      timer
    }
  );
}

function validateWavesV2Params(
  query: Partial<FindWavesV2Request>
): FindWavesV2Request {
  const queryToValidate = query as FindWavesV2Request;
  const { view } = getValidatedByJoiOrThrow(
    query as { view: ApiWavesV2ListType },
    Joi.object<{ view: ApiWavesV2ListType }>({
      view: Joi.string()
        .uppercase()
        .valid(...Object.values(ApiWavesV2ListType))
        .default(ApiWavesV2ListType.Search)
    }).unknown(true)
  );

  switch (view) {
    case ApiWavesV2ListType.Search:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().default(ApiWavesV2ListType.Search),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(50).default(20),
          name: Joi.string().trim().min(1).optional(),
          author: Joi.string().trim().min(1).optional(),
          serial_no_less_than: Joi.number().integer().min(1).optional(),
          group_id: Joi.string().trim().min(1).optional(),
          direct_message: booleanQuerySchema().optional()
        }).unknown(false)
      );
    case ApiWavesV2ListType.Overview:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().required(),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(20).default(10),
          overview_type: Joi.string()
            .uppercase()
            .valid(...Object.values(ApiWavesOverviewType))
            .required(),
          only_waves_followed_by_authenticated_user: booleanQuerySchema()
            .optional()
            .default(false),
          direct_message: booleanQuerySchema().optional(),
          pinned: Joi.string()
            .uppercase()
            .empty('')
            .valid(...Object.values(ApiWavesPinFilter))
            .optional()
            .default(null),
          score_sort: Joi.string()
            .uppercase()
            .valid(...Object.values(ApiWaveScoreSort))
            .optional(),
          min_visibility_score: Joi.number().min(0).max(100).optional(),
          min_quality_score: Joi.number().min(0).max(100).optional(),
          min_hotness_score: Joi.number().min(0).max(100).optional(),
          min_rep_sort_score: Joi.number().min(0).max(100).optional(),
          visibility_tier: Joi.string()
            .uppercase()
            .valid(...Object.values(ApiWaveVisibilityTier))
            .optional()
        }).unknown(false)
      );
    case ApiWavesV2ListType.Hot:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().required(),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(25).default(25),
          exclude_followed: booleanQuerySchema().optional().default(false)
        }).unknown(false)
      );
    case ApiWavesV2ListType.Favourites:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().required(),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(100).default(50),
          identity: Joi.string().trim().required().min(1).max(200)
        }).unknown(false)
      );
  }
  throw new Error(`Unsupported V2 waves view ${view}`);
}

function waveListViewSchema() {
  return Joi.string()
    .uppercase()
    .valid(...Object.values(ApiWavesV2ListType));
}

function booleanQuerySchema() {
  return Joi.boolean().truthy('true').falsy('false');
}
