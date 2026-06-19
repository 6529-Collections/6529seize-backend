import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { abusivenessCheckDb } from '../../../profiles/abusiveness-check.db';
import { BadRequestException } from '../../../exceptions';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { ApiGlobalRepCategorySuggestedCategory } from '../generated/models/ApiGlobalRepCategorySuggestedCategory';
import { globalRepCategoryApiService } from '../rep-categories/global-rep-category.api.service';
import { getAuthenticationContext } from '../auth/auth';
import { Timer } from '../../../time';

const router = asyncRouter();

router.get(
  `/top`,
  async function (
    req: Request,
    res: Response<ApiResponse<ApiGlobalRepCategorySuggestedCategory[]>>
  ) {
    const timer = Timer.getFromRequest(req);
    res.send(
      await globalRepCategoryApiService.getSuggestedCategories({
        timer,
        authenticationContext: await getAuthenticationContext(req, timer)
      })
    );
  }
);

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
      await abusivenessCheckService.checkRepPhrase(searchParam);
    if (abusivenessDetectionResult.status === 'DISALLOWED') {
      throw new BadRequestException(
        abusivenessDetectionResult.explanation ??
          'Given category is not allowed'
      );
    }
    res.send(true);
  }
);

export default router;
