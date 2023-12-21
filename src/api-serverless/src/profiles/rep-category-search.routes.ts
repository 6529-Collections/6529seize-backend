import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { abusivenessCheckDb } from '../../../profiles/abusiveness-check.db';

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

export default router;
