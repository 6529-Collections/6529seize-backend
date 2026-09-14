import { getAuthenticationContext } from '@/api/auth/auth';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { ApiDeleteMyWaveChatHistoryResponse } from '@/api/generated/models/ApiDeleteMyWaveChatHistoryResponse';
import {
  DeleteMyWaveChatHistoryRequest,
  PrepareMyWaveChatHistoryPurgeRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { ApiWaveChatHistoryPurgePlan } from '@/api/generated/models/ApiWaveChatHistoryPurgePlan';
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
  const { purge_token } = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ purge_token?: string }>({
      purge_token: Joi.string().max(2048)
    })
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropCreationService.deleteMyWaveChatHistory(
    { waveId: id, purgeToken: purge_token },
    { authenticationContext, timer }
  );
}

export async function handlePrepareMyWaveChatHistoryPurge(
  req: PrepareMyWaveChatHistoryPurgeRequest
): Promise<ApiWaveChatHistoryPurgePlan> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    DeleteMyWaveChatHistoryPathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropCreationService.prepareMyWaveChatHistoryPurge(
    { waveId: id },
    { authenticationContext, timer }
  );
}
