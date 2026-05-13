import { getAuthenticationContext } from '@/api/auth/auth';
import {
  apiDropV2Service,
  FindDropsV2Request
} from '@/api/drops/api-drop-v2.service';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { GetDropsV2Request } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

const FindDropsV2QuerySchema: Joi.ObjectSchema<FindDropsV2Request> = Joi.object<
  FindDropsV2Request,
  true
>({
  parent_drop_id: Joi.string().trim().empty('').optional().default(null),
  page_size: Joi.number().integer().min(1).max(100).default(50),
  page: Joi.number().integer().min(1).default(1)
});

export async function handleGetDropsV2(
  req: GetDropsV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const query = getValidatedByJoiOrThrow(req.query, FindDropsV2QuerySchema);
  return apiDropV2Service.findDrops(query, {
    timer,
    authenticationContext
  });
}
