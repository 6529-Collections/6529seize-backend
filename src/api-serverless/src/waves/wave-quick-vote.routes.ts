import { Request, Response } from 'express';
import * as Joi from 'joi';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { ApiUndiscoveredDrop } from '@/api/generated/models/ApiUndiscoveredDrop';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { waveQuickVoteApiService } from '@/api/waves/wave-quick-vote.api.service';
import { Timer } from '@/time';
import { getQuickVoteIdentity } from '@/api/waves/wave-quick-vote-auth';

const router = asyncRouter();

type GetUndiscoveredDropQuery = {
  readonly skip?: number;
};

const GetUndiscoveredDropQuerySchema = Joi.object<GetUndiscoveredDropQuery>({
  skip: Joi.number().integer().min(0).optional()
});

router.get(
  '/:id/undiscovered-drop',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, GetUndiscoveredDropQuery, any>,
    res: Response<ApiResponse<ApiUndiscoveredDrop>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const query = getValidatedByJoiOrThrow(
      req.query,
      GetUndiscoveredDropQuerySchema
    );
    const identityId = getQuickVoteIdentity(authenticationContext);
    const result = await waveQuickVoteApiService.findUndiscoveredDrop(
      {
        waveId: req.params.id,
        identityId,
        skip: query.skip
      },
      { authenticationContext, timer }
    );
    res.send(result);
  }
);

export default router;
