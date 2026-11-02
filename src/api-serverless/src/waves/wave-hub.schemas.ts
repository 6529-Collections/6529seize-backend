import * as Joi from 'joi';
import { ApiUpdateWaveHubRequest } from '@/api/generated/models/ApiUpdateWaveHubRequest';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import {
  WaveScopeSchema,
  WaveVisibilitySchema,
  WaveSchema
} from './wave-write.schemas';
import { getValidatedByJoiOrThrow } from '@/api/validation';

// Strip ignored legacy fields before applying any competition-specific schema.
export const UpdateWaveHubSchema = Joi.object<ApiUpdateWaveHubRequest>({
  name: Joi.string().min(1).max(250),
  picture: Joi.string()
    .pattern(/^https:\/\/d3lqz0a4bldqgf.cloudfront.net\//)
    .allow(null),
  visibility: WaveVisibilitySchema,
  chat: Joi.object({
    scope: WaveScopeSchema,
    enabled: Joi.boolean(),
    links_disabled: Joi.boolean(),
    slow_mode_cooldown_ms: Joi.number().integer().min(1000).allow(null),
    replies: Joi.object({
      open: Joi.boolean().required(),
      collapsed: Joi.boolean().required()
    })
  }),
  admin_group: WaveScopeSchema,
  admin_drop_deletion_enabled: Joi.boolean()
}).options({ stripUnknown: true });

export function legacyWaveHubPatch(
  request: ApiUpdateWaveRequest
): ApiUpdateWaveHubRequest {
  request = getValidatedByJoiOrThrow(
    request,
    Joi.object<ApiUpdateWaveRequest>().unknown(true).required()
  );
  return getValidatedByJoiOrThrow(
    {
      name: request.name,
      picture: request.picture,
      visibility: request.visibility,
      chat: request.chat,
      admin_group: request.wave?.admin_group,
      admin_drop_deletion_enabled: request.wave?.admin_drop_deletion_enabled
    },
    UpdateWaveHubSchema
  );
}

export function legacyWaveCreation(
  request: ApiCreateNewWave
): ApiCreateNewWave {
  const shared = legacyWaveHubPatch(request);
  return getValidatedByJoiOrThrow(
    {
      name: shared.name,
      picture: shared.picture,
      description_drop: request.description_drop,
      parent_wave_id: request.parent_wave_id,
      visibility: shared.visibility,
      chat: shared.chat,
      voting: {
        scope: { group_id: shared.visibility?.scope.group_id ?? null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_category: null,
        creditor_id: null,
        period: { min: null, max: null }
      },
      participation: {
        scope: { group_id: shared.visibility?.scope.group_id ?? null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        period: { min: null, max: null }
      },
      wave: {
        type: ApiWaveType.Chat,
        admin_group: shared.admin_group ?? { group_id: null },
        admin_drop_deletion_enabled: shared.admin_drop_deletion_enabled,
        winning_threshold: null,
        max_winners: null,
        time_lock_ms: null,
        decisions_strategy: null
      },
      outcomes: []
    },
    WaveSchema
  );
}
