import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { abusivenessCheckDb } from '../../../profiles/abusiveness-check.db';
import { BadRequestException } from '../../../exceptions';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';

const router = asyncRouter();

router.get(
  `/`,
  async function (
    req: Request<
      any,
      any,
      any,
      {
        param?: string | null;
      },
      any
    >,
    res: Response<ApiResponse<string[]>>
  ) {
    const searchParam = req.query.param?.trim() ?? '';
    if (searchParam.length < 3 || searchParam.length > 100) {
      res.send([]);
    } else {
      const categories = await abusivenessCheckDb.searchAllowedTextsLike({
        text: searchParam,
        limit: 10
      });
      res.send(categories);
    }
  }
);

router.get(
  '/availability',
  async function (
    req: Request<
      any,
      any,
      any,
      {
        param?: string | null;
      },
      any
    >,
    res: Response<ApiResponse<boolean>>
  ) {
    const searchParam = req.query.param?.trim() ?? '';
    if (searchParam.length < 3 || searchParam.length > 100) {
      throw new BadRequestException(`Given category is not allowed`);
    }
    const abusivenessDetectionResult =
      await abusivenessCheckService.checkAbusiveness(searchParam);
    if (abusivenessDetectionResult.status === 'DISALLOWED') {
      throw new BadRequestException(`Given category is not allowed`);
    }
    res.send(true);
  }
);

export default router;
