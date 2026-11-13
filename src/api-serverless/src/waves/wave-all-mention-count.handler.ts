import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiWaveAllMentionCount } from '@/api/generated/models/ApiWaveAllMentionCount';
import { GetWaveAllMentionCountRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { Timer } from '@/time';
import * as Joi from 'joi';

export async function handleGetWaveAllMentionCount(
  req: GetWaveAllMentionCountRequest
): Promise<ApiWaveAllMentionCount> {
  const { waveId } = getValidatedByJoiOrThrow(
    req.params,
    Joi.object<{ waveId: string }>({ waveId: Joi.string().required() })
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return {
    count: await createOrUpdateDrop.countAllMentionRecipients(waveId, {
      authenticationContext,
      timer
    })
  };
}
