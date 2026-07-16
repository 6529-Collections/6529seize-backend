import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiWaveMentionSearchResult } from '@/api/generated/models/ApiWaveMentionSearchResult';
import { SearchWaveMentionsRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { waveMentionSearchApiService } from '@/api/waves/wave-mention-search.api.service';
import { PROFILE_HANDLE_REGEX } from '@/constants';
import { Timer } from '@/time';
import * as Joi from 'joi';

type SearchWaveMentionsPathParams = {
  readonly waveId: string;
};

type SearchWaveMentionsQuery = {
  readonly handle: string;
  readonly limit: number;
};

const SearchWaveMentionsPathParamsSchema: Joi.ObjectSchema<SearchWaveMentionsPathParams> =
  Joi.object({
    waveId: Joi.string().required()
  });

const SearchWaveMentionsQuerySchema: Joi.ObjectSchema<SearchWaveMentionsQuery> =
  Joi.object({
    handle: Joi.string()
      .trim()
      .lowercase()
      .min(3)
      .max(15)
      .pattern(PROFILE_HANDLE_REGEX)
      .required(),
    limit: Joi.number().integer().min(1).max(20).optional().default(5)
  });

export async function handleSearchWaveMentions(
  req: SearchWaveMentionsRequest
): Promise<ApiWaveMentionSearchResult[]> {
  const { waveId } = getValidatedByJoiOrThrow(
    req.params,
    SearchWaveMentionsPathParamsSchema
  );
  const query = getValidatedByJoiOrThrow(
    req.query,
    SearchWaveMentionsQuerySchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return await waveMentionSearchApiService.search(
    { waveId, ...query },
    { authenticationContext, timer }
  );
}
