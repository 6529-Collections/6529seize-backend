import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { SearchDropsInWaveV2Request } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { apiWaveV2Service } from '@/api/waves/api-wave-v2.service';
import { Timer } from '@/time';
import * as Joi from 'joi';

type SearchDropsInWaveV2PathParams = {
  waveId: string;
};

type SearchDropsInWaveV2Query = {
  term: string;
  page: number;
  size: number;
};

const SearchDropsInWaveV2PathParamsSchema: Joi.ObjectSchema<SearchDropsInWaveV2PathParams> =
  Joi.object({
    waveId: Joi.string().required()
  });

const SearchDropsInWaveV2QuerySchema: Joi.ObjectSchema<SearchDropsInWaveV2Query> =
  Joi.object<SearchDropsInWaveV2Query>({
    term: Joi.string().min(1).required(),
    size: Joi.number().integer().min(1).max(100).optional().default(20),
    page: Joi.number().integer().min(1).optional().default(1)
  });

export async function handleSearchDropsInWaveV2(
  req: SearchDropsInWaveV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const { waveId } = getValidatedByJoiOrThrow(
    req.params,
    SearchDropsInWaveV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { term, page, size } = getValidatedByJoiOrThrow(
    req.query,
    SearchDropsInWaveV2QuerySchema
  );
  return apiWaveV2Service.searchDropsContainingPhraseInWave(
    { term, page, size, wave_id: waveId },
    {
      authenticationContext,
      timer
    }
  );
}
