import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { Wave } from '../generated/models/Wave';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { BadRequestException } from '../../../exceptions';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateNewWave, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    throw new BadRequestException(`Not implemented yet`);
  }
);

router.get(
  '/',
  async (
    req: Request<any, any, any, any, any>,
    res: Response<ApiResponse<Wave[]>>
  ) => {
    throw new BadRequestException(`Not implemented yet`);
  }
);

export default router;
