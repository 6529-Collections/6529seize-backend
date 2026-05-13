import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiWaveOverviewPage } from '@/api/generated/models/ApiWaveOverviewPage';
import { ApiWavesOverviewType } from '@/api/generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '@/api/generated/models/ApiWavesPinFilter';
import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import { GetWavesV2Request } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  apiWaveV2Service,
  FindWavesV2Request
} from '@/api/waves/api-wave-v2.service';
import { Timer } from '@/time';
import * as Joi from 'joi';

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
            .default(null)
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
