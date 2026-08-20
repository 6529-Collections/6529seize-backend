import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiGroupMembersPreviewRequest } from '@/api/generated/models/ApiGroupMembersPreviewRequest';
import { ApiCommunityMembersPage } from '@/api/generated/models/ApiCommunityMembersPage';
import { PreviewGroupMembersRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { communityMembersService } from './community-members.service';
import { CommunityMembersQuerySchema } from './community-members-query.schema';
import { PreviewGroupDescriptionSchema } from './group-description.schema';

const GroupMembersPreviewRequestSchema =
  Joi.object<ApiGroupMembersPreviewRequest>({
    group: PreviewGroupDescriptionSchema.required()
  }).required();

export async function handlePreviewGroupMembers(
  req: PreviewGroupMembersRequest
): Promise<ApiCommunityMembersPage> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const body = getValidatedByJoiOrThrow(
    req.body,
    GroupMembersPreviewRequestSchema
  );
  const query = getValidatedByJoiOrThrow(
    {
      ...req.query,
      group_id: null
    },
    CommunityMembersQuerySchema
  );
  return await communityMembersService.getCommunityMembersPage(
    query,
    { authenticationContext, timer },
    body.group
  );
}
