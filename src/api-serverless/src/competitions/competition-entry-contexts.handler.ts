import * as Joi from 'joi';
import { GetCompetitionEntryContextsV3Request } from '@/api/generated/routes/operations';
import { ApiCompetitionEntryContextPage } from '@/api/generated/models/ApiCompetitionEntryContextPage';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { getContext } from './competitions-v3.handlers';
import { readCompetitionEntryContexts } from './competition-entry-context.reader';

export async function handleGetCompetitionEntryContextsV3(
  req: GetCompetitionEntryContextsV3Request
): Promise<ApiCompetitionEntryContextPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    Joi.object({
      wave_id: Joi.string().min(1).max(100).required(),
      competition_id: Joi.string().uuid().required()
    }).unknown(false)
  );
  const { entry_ids, include } = getValidatedByJoiOrThrow(
    req.query,
    // 50 canonical UUIDs plus 49 commas. The array schema validates each ID.
    Joi.object<{ entry_ids: string; include?: 'cards' }>({
      entry_ids: Joi.string().min(1).max(1849).required(),
      include: Joi.string().valid('cards').optional()
    }).unknown(false)
  );
  const { ids } = getValidatedByJoiOrThrow(
    { ids: entry_ids.split(',') },
    Joi.object<{ ids: string[] }>({
      ids: Joi.array()
        .items(Joi.string().uuid())
        .min(1)
        .max(50)
        .unique()
        .required()
    })
  );
  const ctx = await getContext(req);
  return readCompetitionEntryContexts(
    wave_id,
    competition_id,
    ids,
    ctx,
    include === 'cards'
  );
}
