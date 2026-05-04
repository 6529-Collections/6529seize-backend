import { Request, Response } from 'express';
import { enums } from '@/enums';
import { numbers } from '@/numbers';
import { Timer } from '@/time';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '@/api/auth/auth';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveDropsFeedV2 } from '@/api/generated/models/ApiWaveDropsFeedV2';
import { apiWaveV2Service } from '@/api/waves/api-wave-v2.service';

const router = asyncRouter();

router.get(
  '/:id/drops',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      {
        drop_id?: string;
        limit?: string;
        serial_no_limit?: string;
        search_strategy?: string;
        drop_type?: ApiDropType;
        curation_id?: string;
      },
      any
    >,
    res: Response<ApiResponse<ApiWaveDropsFeedV2>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.query.drop_id ?? null;
    const amount = numbers.parseIntOrNull(req.query.limit) ?? 200;
    const serialNoLimit = numbers.parseIntOrNull(req.query.serial_no_limit);
    const searchStrategy =
      enums.resolve(ApiDropSearchStrategy, req.query.search_strategy) ??
      ApiDropSearchStrategy.Older;
    const dropType = req.query.drop_type
      ? (enums.resolve(ApiDropType, req.query.drop_type) ?? null)
      : null;
    const curationId = req.query.curation_id ?? null;
    const result = await apiWaveV2Service.findDropsFeed(
      {
        wave_id: id,
        drop_id: dropId,
        amount: amount >= 200 || amount < 1 ? 50 : amount,
        serial_no_limit: serialNoLimit,
        search_strategy: searchStrategy,
        drop_type: dropType,
        curation_id: curationId
      },
      { authenticationContext, timer }
    );
    res.send(result);
  }
);

export default router;
