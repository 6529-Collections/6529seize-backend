import { asyncRouter } from '@/api/async.router';
import { Request, Response } from 'express';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '@/api/auth/auth';
import { ApiResponse } from '@/api/api-response';
import { Timer } from '@/time';
import { ApiDropAndWave } from '@/api/generated/models/ApiDropAndWave';
import {
  apiDropV2Service,
  DropVotersSearchParams,
  DropVoteEditLogsSearchParams
} from '@/api/drops/api-drop-v2.service';
import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';
import { ApiDropPartV2 } from '@/api/generated/models/ApiDropPartV2';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ApiDropBoostV2 } from '@/api/generated/models/ApiDropBoostV2';
import { ApiDropVoteEditLog } from '@/api/generated/models/ApiDropVoteEditLog';
import { PageSortDirection } from '@/api/page-request';
import { ApiDropVotersPage } from '@/api/generated/models/ApiDropVotersPage';
import { ApiDropReactionV2 } from '@/api/generated/models/ApiDropReactionV2';

const router = asyncRouter();

type DropPartPathParams = {
  drop_id: string;
  part_no: number;
};

const DropPartPathParamsSchema: Joi.ObjectSchema<DropPartPathParams> =
  Joi.object({
    drop_id: Joi.string().required(),
    part_no: Joi.number().integer().min(1).required()
  });

const DropVoteEditLogsQuerySchema: Joi.ObjectSchema<DropVoteEditLogsSearchParams> =
  Joi.object({
    offset: Joi.number().integer().min(0).default(0),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.DESC)
  });

const DropVotersQuerySchema: Joi.ObjectSchema<DropVotersSearchParams> =
  Joi.object({
    page_size: Joi.number().integer().min(1).max(100).default(20),
    page: Joi.number().integer().min(1).default(1),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.DESC)
  });

router.get(
  '/:drop_id/metadata',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropMetadataV2[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const metadata = await apiDropV2Service.findMetadataByDropIdOrThrow(
      dropId,
      {
        timer,
        authenticationContext
      }
    );
    res.send(metadata);
  }
);

router.get(
  '/:drop_id/parts/:part_no',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string; part_no: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropPartV2>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { drop_id: dropId, part_no: partNo } = getValidatedByJoiOrThrow(
      req.params as unknown as DropPartPathParams,
      DropPartPathParamsSchema
    );
    const part = await apiDropV2Service.findPartByDropIdOrThrow(
      dropId,
      partNo,
      {
        timer,
        authenticationContext
      }
    );
    res.send(part);
  }
);

router.get(
  '/:drop_id/boosts',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropBoostV2[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const boosts = await apiDropV2Service.findBoostsByDropIdOrThrow(dropId, {
      timer,
      authenticationContext
    });
    res.send(boosts);
  }
);

router.get(
  '/:drop_id/votes/logs',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropVoteEditLog[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const query = getValidatedByJoiOrThrow(
      req.query as unknown as DropVoteEditLogsSearchParams,
      DropVoteEditLogsQuerySchema
    );
    const logs = await apiDropV2Service.findVoteEditLogsByDropIdOrThrow(
      dropId,
      query,
      {
        timer,
        authenticationContext
      }
    );
    res.send(logs);
  }
);

router.get(
  '/:drop_id/reactions',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropReactionV2[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const reactions = await apiDropV2Service.findReactionsByDropIdOrThrow(
      dropId,
      {
        timer,
        authenticationContext
      }
    );
    res.send(reactions);
  }
);

router.get(
  '/:drop_id/votes',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropVotersPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const query = getValidatedByJoiOrThrow(
      req.query as unknown as DropVotersSearchParams,
      DropVotersQuerySchema
    );
    const voters = await apiDropV2Service.findVotersByDropIdOrThrow(
      dropId,
      query,
      {
        timer,
        authenticationContext
      }
    );
    res.send(voters);
  }
);

router.get(
  '/:drop_id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropAndWave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const drop = await apiDropV2Service.findWithWaveByIdOrThrow(dropId, {
      timer,
      authenticationContext
    });
    res.send(drop);
  }
);

export default router;
