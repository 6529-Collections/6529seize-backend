import { returnCSVResult } from '@/api/api-helpers';
import { getAuthenticationContext } from '@/api/auth/auth';
import {
  apiDropV2Service,
  DropVoteEditLogsSearchParams,
  DropVotersSearchParams,
  FindBoostedDropsV2Request,
  FindCuratedProfileWaveDropsV2Request,
  FindDropsV2Request
} from '@/api/drops/api-drop-v2.service';
import { ApiDropAndWave } from '@/api/generated/models/ApiDropAndWave';
import { ApiDropBoostV2 } from '@/api/generated/models/ApiDropBoostV2';
import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';
import { ApiDropPartV2 } from '@/api/generated/models/ApiDropPartV2';
import { ApiDropReactionV2 } from '@/api/generated/models/ApiDropReactionV2';
import { ApiDropV2Page } from '@/api/generated/models/ApiDropV2Page';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { ApiDropVoteEditLog } from '@/api/generated/models/ApiDropVoteEditLog';
import { ApiDropVotersPage } from '@/api/generated/models/ApiDropVotersPage';
import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import {
  DownloadDropV2VotersByIdRequest,
  GetBoostedDropsV2Request,
  GetCuratedProfileWaveDropsV2Request,
  GetDropsV2Request,
  GetDropV2BoostsByIdRequest,
  GetDropV2ByIdRequest,
  GetDropV2MetadataByIdRequest,
  GetDropV2PartByIdRequest,
  GetDropV2ReactionsByIdRequest,
  GetDropV2VoteEditLogsByIdRequest,
  GetDropV2VotersByIdRequest
} from '@/api/generated/routes/operations';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  PageSortDirection
} from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { Response } from 'express';
import * as Joi from 'joi';
import { SerialNosQueryParamSchema } from '@/api/drops/drop.validator';

const FindBoostedDropsV2RequestSchema: Joi.ObjectSchema<FindBoostedDropsV2Request> =
  Joi.object<FindBoostedDropsV2Request>({
    author: Joi.string().default(null),
    booster: Joi.string().default(null),
    wave_id: Joi.string().default(null),
    min_boosts: Joi.number().integer().default(null),
    count_only_boosts_after: Joi.number().integer().positive().default(1),
    page_size: Joi.number()
      .integer()
      .default(DEFAULT_PAGE_SIZE)
      .max(DEFAULT_MAX_SIZE)
      .min(1),
    page: Joi.number().integer().default(1).min(1),
    sort_direction: Joi.string()
      .valid(...Object.values(ApiPageSortDirection))
      .default(ApiPageSortDirection.Desc),
    sort: Joi.string()
      .valid('last_boosted_at', 'first_boosted_at', 'drop_created_at', 'boosts')
      .default('last_boosted_at')
  });

const FindCuratedProfileWaveDropsV2RequestSchema: Joi.ObjectSchema<FindCuratedProfileWaveDropsV2Request> =
  Joi.object({
    page: Joi.number().integer().default(1).min(1),
    page_size: Joi.number()
      .integer()
      .default(DEFAULT_PAGE_SIZE)
      .max(DEFAULT_MAX_SIZE)
      .min(1)
  });

const FindDropsV2QuerySchema = Joi.object({
  parent_drop_id: Joi.string().trim().empty('').optional().default(null),
  serial_nos: SerialNosQueryParamSchema,
  page_size: Joi.number().integer().min(1).max(100).default(50),
  page: Joi.number().integer().min(1).default(1)
}) as Joi.ObjectSchema<FindDropsV2Request>;

type GetDropV2ByIdPathParams = {
  id: string;
};

const GetDropV2ByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2ByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

type GetDropV2MetadataByIdPathParams = {
  id: string;
};

const GetDropV2MetadataByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2MetadataByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

type GetDropV2PartByIdPathParams = {
  id: string;
  part_no: number;
};

const GetDropV2PartByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2PartByIdPathParams> =
  Joi.object({
    id: Joi.string().required(),
    part_no: Joi.number().integer().min(1).required()
  });

type GetDropV2BoostsByIdPathParams = {
  id: string;
};

const GetDropV2BoostsByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2BoostsByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

type GetDropV2ReactionsByIdPathParams = {
  id: string;
};

const GetDropV2ReactionsByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2ReactionsByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

type GetDropV2VotersByIdPathParams = {
  id: string;
};

const GetDropV2VotersByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2VotersByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetDropV2VotersByIdQuerySchema: Joi.ObjectSchema<DropVotersSearchParams> =
  Joi.object({
    page_size: Joi.number().integer().min(1).max(100).default(20),
    page: Joi.number().integer().min(1).default(1),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.DESC)
  });

type DownloadDropV2VotersByIdPathParams = {
  id: string;
};

const DownloadDropV2VotersByIdPathParamsSchema: Joi.ObjectSchema<DownloadDropV2VotersByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

type GetDropV2VoteEditLogsByIdPathParams = {
  id: string;
};

const GetDropV2VoteEditLogsByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2VoteEditLogsByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetDropV2VoteEditLogsByIdQuerySchema: Joi.ObjectSchema<DropVoteEditLogsSearchParams> =
  Joi.object({
    offset: Joi.number().integer().min(0).default(0),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.DESC)
  });

export async function handleGetBoostedDropsV2(
  req: GetBoostedDropsV2Request
): Promise<ApiDropV2Page> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const searchRequest = getValidatedByJoiOrThrow(
    req.query,
    FindBoostedDropsV2RequestSchema
  );
  return apiDropV2Service.findBoostedDrops(searchRequest, {
    timer,
    authenticationContext
  });
}

export async function handleGetCuratedProfileWaveDropsV2(
  req: GetCuratedProfileWaveDropsV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const request =
    getValidatedByJoiOrThrow<FindCuratedProfileWaveDropsV2Request>(
      req.query,
      FindCuratedProfileWaveDropsV2RequestSchema
    );
  return apiDropV2Service.findCuratedProfileWaveDrops(request, {
    authenticationContext,
    timer
  });
}

export async function handleGetDropsV2(
  req: GetDropsV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const query = getValidatedByJoiOrThrow(req.query, FindDropsV2QuerySchema);
  return apiDropV2Service.findDrops(query, {
    timer,
    authenticationContext
  });
}

export async function handleGetDropV2ById(
  req: GetDropV2ByIdRequest
): Promise<ApiDropAndWave> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2ByIdPathParamsSchema
  );
  return apiDropV2Service.findWithWaveByIdOrThrow(id, {
    timer,
    authenticationContext
  });
}

export async function handleGetDropV2MetadataById(
  req: GetDropV2MetadataByIdRequest
): Promise<ApiDropMetadataV2[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2MetadataByIdPathParamsSchema
  );
  return apiDropV2Service.findMetadataByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
}

export async function handleGetDropV2PartById(
  req: GetDropV2PartByIdRequest
): Promise<ApiDropPartV2> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id, part_no } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2PartByIdPathParamsSchema
  );
  return apiDropV2Service.findPartByDropIdOrThrow(id, part_no, {
    timer,
    authenticationContext
  });
}

export async function handleGetDropV2BoostsById(
  req: GetDropV2BoostsByIdRequest
): Promise<ApiDropBoostV2[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2BoostsByIdPathParamsSchema
  );
  return apiDropV2Service.findBoostsByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
}

export async function handleGetDropV2ReactionsById(
  req: GetDropV2ReactionsByIdRequest
): Promise<ApiDropReactionV2[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2ReactionsByIdPathParamsSchema
  );
  return apiDropV2Service.findReactionsByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
}

export async function handleGetDropV2VotersById(
  req: GetDropV2VotersByIdRequest
): Promise<ApiDropVotersPage> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2VotersByIdPathParamsSchema
  );
  const query = getValidatedByJoiOrThrow(
    req.query,
    GetDropV2VotersByIdQuerySchema
  );
  return apiDropV2Service.findVotersByDropIdOrThrow(id, query, {
    timer,
    authenticationContext
  });
}

export async function handleDownloadDropV2VotersById(
  req: DownloadDropV2VotersByIdRequest,
  res: Response<string>
): Promise<void> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    DownloadDropV2VotersByIdPathParamsSchema
  );
  const voters = await apiDropV2Service.findVotersCsvByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
  await returnCSVResult(`drop-${id}-votes`, voters, res);
}

export async function handleGetDropV2VoteEditLogsById(
  req: GetDropV2VoteEditLogsByIdRequest
): Promise<ApiDropVoteEditLog[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2VoteEditLogsByIdPathParamsSchema
  );
  const query = getValidatedByJoiOrThrow(
    req.query,
    GetDropV2VoteEditLogsByIdQuerySchema
  );
  return apiDropV2Service.findVoteEditLogsByDropIdOrThrow(id, query, {
    timer,
    authenticationContext
  });
}
