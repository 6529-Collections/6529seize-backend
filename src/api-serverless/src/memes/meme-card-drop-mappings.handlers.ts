import { ApiMemeCardDropMapping } from '@/api/generated/models/ApiMemeCardDropMapping';
import { GetMemeCardDropMappingRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { NotFoundException } from '@/exceptions';
import { memeCardDropMappingsDb } from '@/minting-claims/meme-card-drop-mappings.db';
import { Timer } from '@/time';
import * as Joi from 'joi';

const GetMemeCardDropMappingPathSchema = Joi.object({
  meme_card_id: Joi.number().integer().min(1).required()
});

export async function handleGetMemeCardDropMapping(
  req: GetMemeCardDropMappingRequest
): Promise<ApiMemeCardDropMapping> {
  const timer = Timer.getFromRequest(req);
  const { meme_card_id } = getValidatedByJoiOrThrow(
    req.params,
    GetMemeCardDropMappingPathSchema
  );
  const mapping = await memeCardDropMappingsDb.findByMemeCardId(meme_card_id, {
    timer
  });
  if (!mapping) {
    throw new NotFoundException(
      `Main Stage drop mapping for Meme card ${meme_card_id} not found`
    );
  }
  return mapping;
}
