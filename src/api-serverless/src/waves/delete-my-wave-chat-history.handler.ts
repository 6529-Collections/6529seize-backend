import { getAuthenticationContext } from '@/api/auth/auth';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { ApiDeleteMyWaveChatHistoryResponse } from '@/api/generated/models/ApiDeleteMyWaveChatHistoryResponse';
import { DeleteMyWaveChatHistoryRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

const DeleteMyWaveChatHistoryPathParamsSchema = Joi.object<{ id: string }>({
  id: Joi.string().required()
});

export async function handleDeleteMyWaveChatHistory(
  req: DeleteMyWaveChatHistoryRequest
): Promise<ApiDeleteMyWaveChatHistoryResponse> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    DeleteMyWaveChatHistoryPathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropCreationService.deleteMyWaveChatHistory(
    { waveId: id },
    { authenticationContext, timer }
  );
}
