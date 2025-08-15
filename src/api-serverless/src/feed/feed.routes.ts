import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { ApiResponse } from '../api-response';
import { ApiFeedItem } from '../generated/models/ApiFeedItem';
import { feedApiService } from './feed.api.service';
import { numbers } from '../../../numbers';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        serial_no_less_than?: number;
      },
      any
    >,
    res: Response<ApiResponse<ApiFeedItem[]>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const feed = await feedApiService.getFeed(
      {
        serial_no_less_than: numbers.parseIntOrNull(
          req.query.serial_no_less_than
        )
      },
      authenticationContext
    );
    res.send(feed);
  }
);

export default router;
