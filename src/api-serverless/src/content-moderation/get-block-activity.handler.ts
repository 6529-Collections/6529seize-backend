import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiContentModerationBlockActivityItem } from '@/api/generated/models/ApiContentModerationBlockActivityItem';
import { GetContentModerationBlockActivityRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { contentModerationService } from '@/content-moderation/content-moderation.service';
import { ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import * as Joi from 'joi';

const QuerySchema = Joi.object<{
  limit: number;
  before?: string;
  include_unblocks: boolean;
}>({
  limit: Joi.number().integer().min(1).max(100).default(50),
  before: Joi.string().trim().min(1).max(1000).optional(),
  include_unblocks: Joi.boolean().default(false)
})
  .unknown(false)
  .required();

export async function handleGetContentModerationBlockActivity(
  req: GetContentModerationBlockActivityRequest
): Promise<ApiContentModerationBlockActivityItem[]> {
  const query = getValidatedByJoiOrThrow(req.query, QuerySchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(
      'Content moderation actions cannot be performed through a proxy'
    );
  }
  const profileId = authenticationContext.getActingAsId();
  if (!profileId) {
    throw new ForbiddenException('Please create a profile first');
  }
  return contentModerationService.getBlockActivity(profileId, query, {
    timer,
    authenticationContext
  });
}
