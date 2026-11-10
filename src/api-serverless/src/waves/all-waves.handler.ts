import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiAllWavesPage } from '@/api/generated/models/ApiAllWavesPage';
import { GetAllWavesRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  allWavesApiService,
  AllWavesQuery
} from '@/api/waves/all-waves.api.service';
import { Timer } from '@/time';

const schema = Joi.object<AllWavesQuery>({
  page_size: Joi.number().integer().min(1).max(100).default(20),
  cursor: Joi.string().min(1).max(256).optional()
});

export async function handleGetAllWaves(
  req: GetAllWavesRequest
): Promise<ApiAllWavesPage> {
  const timer = Timer.getFromRequest(req);
  const query = getValidatedByJoiOrThrow(req.query, schema);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return await allWavesApiService.findPage(query, {
    authenticationContext,
    timer
  });
}
