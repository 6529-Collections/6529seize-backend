import { getAuthenticationContext } from '@/api/auth/auth';
import { GetDropBookmarksStatusRequest } from '@/api/generated/routes/operations';
import { ApiDropBookmarksStatus } from '@/api/generated/models/ApiDropBookmarksStatus';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { dropBookmarksApiService } from './drop-bookmarks.api.service';

export async function getDropBookmarksStatus(
  req: GetDropBookmarksStatusRequest
): Promise<ApiDropBookmarksStatus> {
  req.res?.set('Cache-Control', 'private, no-store');
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const query = getValidatedByJoiOrThrow<{ drop_id?: string }>(
    req.query,
    Joi.object({ drop_id: Joi.string().min(1).max(100) })
  );
  return dropBookmarksApiService.getBookmarkStatus(
    { timer, authenticationContext },
    query.drop_id
  );
}
