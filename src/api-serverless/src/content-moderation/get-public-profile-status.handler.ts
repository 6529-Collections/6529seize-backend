import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ApiContentModerationProfileStatusResponse } from '@/api/generated/models/ApiContentModerationProfileStatusResponse';
import { ApiModeratedProfileStatus } from '@/api/generated/models/ApiModeratedProfileStatus';
import { GetPublicContentModerationProfileStatusRequest } from '@/api/generated/routes/operations';
import { contentModerationService } from '@/content-moderation/content-moderation.service';
import { ModeratedProfileStatus } from '@/entities/IContentModeration';
import { Timer } from '@/time';
import * as Joi from 'joi';

const PathSchema = Joi.object({
  profile_id: Joi.string().trim().max(100).required()
}).required();

export async function handleGetPublicContentModerationProfileStatus(
  req: GetPublicContentModerationProfileStatusRequest
): Promise<ApiContentModerationProfileStatusResponse> {
  const path = getValidatedByJoiOrThrow(req.params, PathSchema);
  const timer = Timer.getFromRequest(req);
  const result = await contentModerationService.getPublicProfileStatus(
    path.profile_id,
    {
      timer
    }
  );
  return {
    profile_id: result.profile_id,
    status:
      result.status === ModeratedProfileStatus.SUSPENDED
        ? ApiModeratedProfileStatus.Suspended
        : ApiModeratedProfileStatus.Active
  };
}
