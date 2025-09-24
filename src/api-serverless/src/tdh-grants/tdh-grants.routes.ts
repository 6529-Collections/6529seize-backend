import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ApiCreateTdhGrant } from '../generated/models/ApiCreateTdhGrant';
import { ApiTdhGrant } from '../generated/models/ApiTdhGrant';
import { getValidatedByJoiOrThrow } from '../validation';
import { ApiCreateTdhGrantSchema } from './tdh-grants.validator';
import { ForbiddenException } from '../../../exceptions';
import { Timer } from '../../../time';
import { createTdhGrantUseCase } from '../../../tdh-grants/create-tdh-grant.use-case';
import { tdhGrantApiConverter } from './tdh-grant.api-converter';
import { appFeatures } from '../../../app-features';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateTdhGrant, any, any>,
    res: Response<ApiResponse<ApiTdhGrant>>
  ) => {
    if (!appFeatures.isXTdhEnabled()) {
      throw new ForbiddenException(
        `This endpoint is part of an ongoing development and is not yet enabled`
      );
    }
    const apiCreateTdhGrant = getValidatedByJoiOrThrow(
      req.body,
      ApiCreateTdhGrantSchema
    );
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const grantorId = authenticationContext.getActingAsId();
    if (!grantorId) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${authenticationContext.authenticatedWallet}`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't create TDH grants`);
    }

    const createCommand = tdhGrantApiConverter.fromApiCreateTdhGrantToModel({
      apiCreateTdhGrant,
      grantorId
    });
    const model = await createTdhGrantUseCase.handle(createCommand, {
      timer
    });
    const apiResponse =
      await tdhGrantApiConverter.fromTdhGrantModelToApiTdhGrant(model);
    res.send(apiResponse);
  }
);

export default router;
