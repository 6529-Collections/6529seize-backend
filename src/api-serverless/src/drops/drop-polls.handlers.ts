import { getAuthenticationContext } from '@/api/auth/auth';
import {
  dropPollsApiService,
  FindWavePollsRequest
} from '@/api/drops/drop-polls.api.service';
import { DropPollsOrderBy, DropPollState } from '@/api/drops/drop-polls.db';
import { ApiDropPollsPage } from '@/api/generated/models/ApiDropPollsPage';
import { ApiDropPollVoteRequest } from '@/api/generated/models/ApiDropPollVoteRequest';
import { ApiDropPollVotersPage } from '@/api/generated/models/ApiDropPollVotersPage';
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import {
  GetDropPollOptionVotersV2Request,
  GetWavePollsV2Request,
  VoteDropPollV2Request
} from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import * as Joi from 'joi';

type DropPollOptionVotersPathParams = {
  readonly id: string;
  readonly option_no: number;
};

type DropPollOptionVotersQuery = {
  readonly page: number;
  readonly page_size: number;
};

type DropPollVotePathParams = {
  readonly id: string;
};

type WavePollsPathParams = {
  readonly id: string;
};

type WavePollsQuery = Omit<FindWavePollsRequest, 'wave_id' | 'state'> & {
  readonly state: 'open' | 'closed' | null;
};

const DropPollOptionVotersPathParamsSchema: Joi.ObjectSchema<DropPollOptionVotersPathParams> =
  Joi.object({
    id: Joi.string().required(),
    option_no: Joi.number().integer().min(1).required()
  });

const DropPollOptionVotersQuerySchema: Joi.ObjectSchema<DropPollOptionVotersQuery> =
  Joi.object({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(100).optional().default(20)
  });

const DropPollVotePathParamsSchema: Joi.ObjectSchema<DropPollVotePathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const DropPollVoteBodySchema: Joi.ObjectSchema<ApiDropPollVoteRequest> =
  Joi.object<ApiDropPollVoteRequest>({
    options: Joi.array()
      .items(Joi.number().integer().min(1))
      .min(1)
      .max(100)
      .required()
  });

const WavePollsPathParamsSchema: Joi.ObjectSchema<WavePollsPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const WavePollsQuerySchema: Joi.ObjectSchema<WavePollsQuery> =
  Joi.object<WavePollsQuery>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(100).optional().default(20),
    order: Joi.string()
      .uppercase()
      .valid(...Object.values(PageSortDirection))
      .optional()
      .default(PageSortDirection.ASC),
    order_by: Joi.string()
      .valid(...Object.values(DropPollsOrderBy))
      .optional()
      .default(DropPollsOrderBy.CREATED_AT),
    state: Joi.string()
      .lowercase()
      .valid('open', 'closed')
      .optional()
      .default(null)
  });

export async function handleGetDropPollOptionVotersV2(
  req: GetDropPollOptionVotersV2Request
): Promise<ApiDropPollVotersPage> {
  const { id, option_no } = getValidatedByJoiOrThrow(
    req.params,
    DropPollOptionVotersPathParamsSchema
  );
  const { page, page_size } = getValidatedByJoiOrThrow(
    req.query,
    DropPollOptionVotersQuerySchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropPollsApiService.findOptionVoters(
    {
      dropId: id,
      optionNo: option_no,
      page,
      pageSize: page_size
    },
    { authenticationContext, timer }
  );
}

export async function handleVoteDropPollV2(
  req: VoteDropPollV2Request
): Promise<ApiDropV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    DropPollVotePathParamsSchema
  );
  const body = getValidatedByJoiOrThrow(req.body, DropPollVoteBodySchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const voterId = authenticationContext.getActingAsId();
  if (!voterId) {
    throw new ForbiddenException(`Please create a profile first`);
  }
  return dropPollsApiService.vote(
    {
      dropId: id,
      voterId,
      options: body.options
    },
    { authenticationContext, timer }
  );
}

export async function handleGetWavePollsV2(
  req: GetWavePollsV2Request
): Promise<ApiDropPollsPage> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    WavePollsPathParamsSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, WavePollsQuerySchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropPollsApiService.findWavePolls(
    {
      wave_id: id,
      page: query.page,
      page_size: query.page_size,
      order: query.order,
      order_by: query.order_by,
      state: mapPollState(query.state)
    },
    { authenticationContext, timer }
  );
}

function mapPollState(state: 'open' | 'closed' | null): DropPollState | null {
  switch (state) {
    case 'open':
      return DropPollState.OPEN;
    case 'closed':
      return DropPollState.CLOSED;
    case null:
      return null;
  }
}
