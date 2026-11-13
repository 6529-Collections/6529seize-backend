import { getAuthenticationContext } from '@/api/auth/auth';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiSetDropReplyCollapseRequest } from '@/api/generated/models/ApiSetDropReplyCollapseRequest';
import {
  SetDropReplyCollapsePathParams,
  SetDropReplyCollapseRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

const pathSchema: Joi.ObjectSchema<SetDropReplyCollapsePathParams> = Joi.object(
  { id: Joi.string().required() }
);
const bodySchema: Joi.ObjectSchema<ApiSetDropReplyCollapseRequest> = Joi.object(
  { collapse_replies: Joi.boolean().strict().required() }
).required();

export async function handleSetDropReplyCollapse(
  req: SetDropReplyCollapseRequest
): Promise<ApiDrop> {
  const { id } = getValidatedByJoiOrThrow(req.params, pathSchema);
  const { collapse_replies } = getValidatedByJoiOrThrow(req.body, bodySchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropCreationService.setDropReplyCollapse(
    { dropId: id, collapseReplies: collapse_replies },
    { authenticationContext, timer }
  );
}
