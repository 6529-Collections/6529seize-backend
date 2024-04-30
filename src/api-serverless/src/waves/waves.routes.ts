import { asyncRouter } from '../async.router';
import {
  getAuthenticatedProfileIdOrNull,
  needsAuthenticatedUser
} from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { Wave } from '../generated/models/Wave';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { ForbiddenException } from '../../../exceptions';
import * as Joi from 'joi';
import { CreateNewWaveScope } from '../generated/models/CreateNewWaveScope';
import { CreateNewWaveVisibilityConfig } from '../generated/models/CreateNewWaveVisibilityConfig';
import { CreateNewWaveVotingConfig } from '../generated/models/CreateNewWaveVotingConfig';
import { WaveScopeType } from '../generated/models/WaveScopeType';
import { WaveCreditType } from '../generated/models/WaveCreditType';
import { WaveCreditScope } from '../generated/models/WaveCreditScope';
import { IntRange } from '../generated/models/IntRange';
import { CreateNewWaveParticipationConfig } from '../generated/models/CreateNewWaveParticipationConfig';
import { WaveRequiredMetadata } from '../generated/models/WaveRequiredMetadata';
import { WaveConfig } from '../generated/models/WaveConfig';
import { WaveType } from '../generated/models/WaveType';
import { parseIntOrNull } from '../../../helpers';
import { WaveOutcome } from '../generated/models/WaveOutcome';
import { getValidatedByJoiOrThrow } from '../validation';
import { waveApiService } from './wave.api.service';
import { SearchWavesParams } from './waves.api.db';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateNewWave, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const request = getValidatedByJoiOrThrow(req.body, WaveSchema);
    const wave = await waveApiService.createWave({
      createWaveRequest: request,
      authorId: authenticatedProfileId
    });
    res.send(wave);
  }
);

router.get(
  '/',
  async (
    req: Request<any, any, any, SearchWavesParams, any>,
    res: Response<ApiResponse<Wave[]>>
  ) => {
    const params = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<SearchWavesParams>({
        limit: Joi.number().integer().min(1).max(50).default(20),
        serial_no_less_than: Joi.number().integer().min(1).optional(),
        curation_criteria_id: Joi.string().optional().min(1)
      })
    );
    const waves = await waveApiService.searchWaves(params);
    res.send(waves);
  }
);

const IntRangeSchema = Joi.object<IntRange>({
  min: Joi.number().integer().required().allow(null),
  max: Joi.number().integer().required().allow(null)
})
  .custom((value, helpers) => {
    const min = parseIntOrNull(value?.min);
    const max = parseIntOrNull(value?.max);
    if (min !== null && max !== null && min > max) {
      return helpers.error('min.max.flip');
    }
  })
  .messages({
    'min.max.flip': `There's a range in request where max is less than min. This is not allowed.`
  });

const WaveScopeSchema = Joi.object<CreateNewWaveScope>({
  type: Joi.string()
    .required()
    .allow(...Object.values(WaveScopeType)),
  curation_id: Joi.when('type', {
    is: Joi.string().valid(WaveScopeType.Curated),
    then: Joi.string().required(),
    otherwise: Joi.valid(null)
  })
});

const WaveVisibilitySchema = Joi.object<CreateNewWaveVisibilityConfig>({
  scope: WaveScopeSchema.required()
});

const WaveVotingSchema = Joi.object<CreateNewWaveVotingConfig>({
  scope: WaveScopeSchema.required(),
  credit_type: Joi.string()
    .allow(...Object.values(WaveCreditType))
    .required(),
  credit_scope: Joi.string()
    .allow(...Object.values(WaveCreditScope))
    .required(),
  credit_category: Joi.when('credit_type', {
    is: Joi.string().valid(WaveCreditType.Rep),
    then: Joi.string().required().allow(null).max(100),
    otherwise: Joi.valid(null)
  }),
  creditor_id: Joi.when('credit_type', {
    is: Joi.string().valid(WaveCreditType.Rep),
    then: Joi.string().required().allow(null),
    otherwise: Joi.valid(null)
  }),
  signature_required: Joi.boolean().required(),
  period: IntRangeSchema.required().allow(null)
});

const WaveRequiredMetadataSchema = Joi.object<WaveRequiredMetadata>({
  name: Joi.string().required().max(250).min(1)
});

const WaveParticipationSchema = Joi.object<CreateNewWaveParticipationConfig>({
  scope: WaveScopeSchema.required(),
  no_of_applications_allowed_per_participant: Joi.number()
    .integer()
    .required()
    .allow(null),
  required_metadata: Joi.array()
    .required()
    .min(0)
    .items(WaveRequiredMetadataSchema),
  signature_required: Joi.boolean().required(),
  period: IntRangeSchema.required().allow(null)
});

const WaveConfigSchema = Joi.object<WaveConfig>({
  type: Joi.string()
    .required()
    .allow(...Object.values(WaveType)),
  winning_thresholds: Joi.when('type', {
    is: Joi.string().valid(WaveType.VoteTallyInRange),
    then: IntRangeSchema.required().or('min', 'max'),
    otherwise: Joi.valid(null)
  }),
  max_winners: Joi.when('type', {
    is: Joi.string().valid(WaveType.TopVoted),
    then: Joi.number().integer().required().allow(null).min(1),
    otherwise: Joi.valid(null)
  }),
  time_lock_ms: Joi.number().integer().required().allow(null).min(1),
  period: IntRangeSchema.required().allow(null)
});

const WaveOutcomeSchema = Joi.object<WaveOutcome>({
  type: Joi.string().required().min(1),
  properties: Joi.object().required()
});

const WaveSchema = Joi.object<CreateNewWave>({
  name: Joi.string().required().max(250).min(1),
  description: Joi.string().required().max(2000).min(1),
  voting: WaveVotingSchema.required(),
  visibility: WaveVisibilitySchema.required(),
  participation: WaveParticipationSchema.required(),
  wave: WaveConfigSchema.required(),
  outcomes: Joi.array().required().min(0).items(WaveOutcomeSchema)
});

export default router;
