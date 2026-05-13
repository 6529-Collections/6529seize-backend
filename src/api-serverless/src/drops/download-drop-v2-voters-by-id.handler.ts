import { returnCSVResult } from '@/api/api-helpers';
import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { DownloadDropV2VotersByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { Response } from 'express';
import * as Joi from 'joi';

type DownloadDropV2VotersByIdPathParams = {
  id: string;
};

const DownloadDropV2VotersByIdPathParamsSchema: Joi.ObjectSchema<DownloadDropV2VotersByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

export async function handleDownloadDropV2VotersById(
  req: DownloadDropV2VotersByIdRequest,
  res: Response<string>
): Promise<void> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    DownloadDropV2VotersByIdPathParamsSchema
  );
  const voters = await apiDropV2Service.findVotersCsvByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
  await returnCSVResult(`drop-${id}-votes`, voters, res);
}
