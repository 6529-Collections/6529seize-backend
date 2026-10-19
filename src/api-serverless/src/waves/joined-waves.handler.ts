import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiJoinedWavesPage } from '@/api/generated/models/ApiJoinedWavesPage';
import { GetJoinedWavesRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  joinedWavesApiService,
  JoinedWavesQuery
} from '@/api/waves/joined-waves.api.service';
import { Timer } from '@/time';

const schema = Joi.object<JoinedWavesQuery>({
  page_size: Joi.number().integer().min(1).max(100).default(20),
  cursor: Joi.string().min(1).max(256).optional()
});

export async function handleGetJoinedWaves(
  req: GetJoinedWavesRequest
): Promise<ApiJoinedWavesPage> {
  const timer = Timer.getFromRequest(req);
  const query = getValidatedByJoiOrThrow(req.query, schema);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return await joinedWavesApiService.findPage(query, {
    authenticationContext,
    timer
  });
}
