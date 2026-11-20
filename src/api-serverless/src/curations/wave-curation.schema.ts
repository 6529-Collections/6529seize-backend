import * as Joi from 'joi';
import { PreviewGroupDescriptionSchema } from '@/api/community-members/group-description.schema';
import { ApiGroupTdhInclusionStrategy } from '@/api/generated/models/ApiGroupTdhInclusionStrategy';
import { ApiWaveCurationRequest } from '@/api/generated/models/ApiWaveCurationRequest';

const CurationGroupDescriptionSchema = PreviewGroupDescriptionSchema.fork(
  ['tdh.inclusion_strategy'],
  (schema) => schema.valid(...Object.values(ApiGroupTdhInclusionStrategy))
);

export const WaveCurationSchema = Joi.object<ApiWaveCurationRequest>({
  name: Joi.string().trim().min(1).max(50).required(),
  group_id: Joi.string(),
  criteria: Joi.object({
    group: CurationGroupDescriptionSchema.required(),
    is_private: Joi.boolean().required()
  }),
  priority_order: Joi.number().integer().min(1).optional()
}).xor('group_id', 'criteria');
