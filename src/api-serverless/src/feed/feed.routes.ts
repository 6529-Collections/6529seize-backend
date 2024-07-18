import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { ApiResponse } from '../api-response';
import { FeedItem } from '../generated/models/FeedItem';
import { feedApiService } from './feed.api.service';
import { parseIntOrNull } from '../../../helpers';

const router = asyncRouter();

router.get(
  '/',
  needsAuthenticatedUser(),
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
    res: Response<ApiResponse<FeedItem[]>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const feed = await feedApiService.getFeed(
      {
        serial_no_less_than: parseIntOrNull(req.query.serial_no_less_than)
      },
      authenticationContext
    );
    res.send(feed);
  }
);

export default router;
