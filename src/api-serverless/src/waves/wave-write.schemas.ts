import * as Joi from 'joi';
import { WALLET_REGEX } from '@/constants';
import { REP_CATEGORY_PATTERN } from '@/entities/IAbusivenessDetectionResult';
import { numbers } from '@/numbers';
import { Time } from '@/time';
import { NewWaveDropSchema } from '@/api/drops/drop.validator';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiCreateNewWaveChatConfig } from '@/api/generated/models/ApiCreateNewWaveChatConfig';
import { ApiCreateNewWaveParticipationConfig } from '@/api/generated/models/ApiCreateNewWaveParticipationConfig';
import { ApiCreateNewWaveScope } from '@/api/generated/models/ApiCreateNewWaveScope';
import { ApiCreateNewWaveVisibilityConfig } from '@/api/generated/models/ApiCreateNewWaveVisibilityConfig';
import { ApiCreateNewWaveVotingConfig } from '@/api/generated/models/ApiCreateNewWaveVotingConfig';
import { ApiCreateWaveOutcome } from '@/api/generated/models/ApiCreateWaveOutcome';
import { ApiIntRange } from '@/api/generated/models/ApiIntRange';
import { ApiUpdateWaveParticipationConfig } from '@/api/generated/models/ApiUpdateWaveParticipationConfig';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { ApiWaveConfig } from '@/api/generated/models/ApiWaveConfig';
import { ApiWaveCreditNft } from '@/api/generated/models/ApiWaveCreditNft';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveDecisionsStrategy } from '@/api/generated/models/ApiWaveDecisionsStrategy';
import { ApiWaveMetadataType } from '@/api/generated/models/ApiWaveMetadataType';
import { ApiWaveOutcomeCredit } from '@/api/generated/models/ApiWaveOutcomeCredit';
import { ApiWaveOutcomeDistributionItem } from '@/api/generated/models/ApiWaveOutcomeDistributionItem';
import { ApiWaveOutcomeSubType } from '@/api/generated/models/ApiWaveOutcomeSubType';
import { ApiWaveOutcomeType } from '@/api/generated/models/ApiWaveOutcomeType';
import { ApiWaveParticipationIdentitySubmissionAllowDuplicates } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionAllowDuplicates';
import { ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted';
import { ApiWaveParticipationRequirement } from '@/api/generated/models/ApiWaveParticipationRequirement';
import { ApiWaveParticipationSubmissionStrategy } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategy';
import { ApiWaveParticipationSubmissionStrategyIdentityConf } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyIdentityConf';
import { ApiWaveParticipationSubmissionStrategyType } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ApiWaveRequiredMetadata } from '@/api/generated/models/ApiWaveRequiredMetadata';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';

const IntRangeSchema = Joi.object<ApiIntRange>({
  min: Joi.number().integer().required().allow(null),
  max: Joi.number().integer().required().allow(null)
})
  .custom((value, helpers) => {
    const min = numbers.parseIntOrNull(value?.min);
    const max = numbers.parseIntOrNull(value?.max);
    if (min !== null && max !== null && min > max) {
      return helpers.error('min.max.flip');
    }
    return { min, max };
  })
  .messages({
    'min.max.flip': `There's a range in request where max is less than min. This is not allowed.`
  });

export const WaveScopeSchema = Joi.object<ApiCreateNewWaveScope>({
  group_id: Joi.string().required().allow(null)
});

export const WaveVisibilitySchema =
  Joi.object<ApiCreateNewWaveVisibilityConfig>({
    scope: WaveScopeSchema.required()
  });

const WaveCreditNftSchema = Joi.object<ApiWaveCreditNft>({
  contract: Joi.string().required().regex(WALLET_REGEX).lowercase(),
  token_id: Joi.number().integer().required().min(0)
});
const WaveCreditNftsSchema = Joi.array()
  .items(WaveCreditNftSchema)
  .required()
  .min(1);

export const WaveVotingSchema = Joi.object<ApiCreateNewWaveVotingConfig>({
  scope: WaveScopeSchema.required(),
  credit_type: Joi.string()
    .valid(...Object.values(ApiWaveCreditType))
    .required(),
  credit_scope: Joi.string()
    .optional()
    .valid(...Object.values(ApiWaveCreditScope)),
  credit_category: Joi.when('credit_type', {
    is: Joi.string().valid(ApiWaveCreditType.Rep),
    then: Joi.string().required().allow(null).max(100),
    otherwise: Joi.valid(null).default(null)
  }),
  credit_nfts: Joi.when('credit_type', {
    is: Joi.string().valid(ApiWaveCreditType.CardSetTdh),
    then: WaveCreditNftsSchema,
    otherwise: Joi.valid(null).default(null)
  }),
  creditor_id: Joi.when('credit_type', {
    is: Joi.string().valid(ApiWaveCreditType.Rep),
    then: Joi.string().required().allow(null),
    otherwise: Joi.valid(null).default(null)
  }),
  signature_required: Joi.boolean().optional().default(false),
  period: IntRangeSchema.required().allow(null),
  forbid_negative_votes: Joi.boolean().optional().default(false)
});

const WaveRequiredMetadataSchema = Joi.object<ApiWaveRequiredMetadata>({
  name: Joi.string().required().max(250).min(1),
  type: Joi.string()
    .required()
    .valid(...Object.values(ApiWaveMetadataType))
});

const WaveParticipationSubmissionStrategyIdentityConfSchema =
  Joi.object<ApiWaveParticipationSubmissionStrategyIdentityConf>({
    duplicates: Joi.string()
      .required()
      .valid(
        ...Object.values(ApiWaveParticipationIdentitySubmissionAllowDuplicates)
      ),
    who_can_be_submitted: Joi.string()
      .required()
      .valid(
        ...Object.values(
          ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted
        )
      )
  });

const WaveParticipationSubmissionStrategySchema =
  Joi.alternatives<ApiWaveParticipationSubmissionStrategy | null>()
    .try(
      Joi.valid(null),
      Joi.object<ApiWaveParticipationSubmissionStrategy>({
        type: Joi.string()
          .required()
          .valid(...Object.values(ApiWaveParticipationSubmissionStrategyType)),
        config: WaveParticipationSubmissionStrategyIdentityConfSchema.required()
      })
    )
    .default(null);

const WaveUpdateParticipationSubmissionStrategySchema =
  Joi.alternatives<ApiWaveParticipationSubmissionStrategy | null>()
    .try(
      Joi.valid(null),
      Joi.object<ApiWaveParticipationSubmissionStrategy>({
        type: Joi.string()
          .required()
          .valid(...Object.values(ApiWaveParticipationSubmissionStrategyType)),
        config: WaveParticipationSubmissionStrategyIdentityConfSchema.required()
      })
    )
    .optional();

export const WaveParticipationSchema =
  Joi.object<ApiCreateNewWaveParticipationConfig>({
    scope: WaveScopeSchema.required(),
    no_of_applications_allowed_per_participant: Joi.number()
      .integer()
      .required()
      .allow(null),
    required_metadata: Joi.array()
      .required()
      .min(0)
      .items(WaveRequiredMetadataSchema),
    required_media: Joi.array()
      .items(
        Joi.string().valid(...Object.values(ApiWaveParticipationRequirement))
      )
      .optional()
      .default([]),
    signature_required: Joi.boolean().optional().default(false),
    period: IntRangeSchema.required().allow(null),
    terms: Joi.string().optional().allow(null).default(null),
    submission_strategy: WaveParticipationSubmissionStrategySchema
  });

const UpdateWaveParticipationSchema =
  Joi.object<ApiUpdateWaveParticipationConfig>({
    scope: WaveScopeSchema.required(),
    no_of_applications_allowed_per_participant: Joi.number()
      .integer()
      .required()
      .allow(null),
    required_metadata: Joi.array()
      .required()
      .min(0)
      .items(WaveRequiredMetadataSchema),
    required_media: Joi.array()
      .items(
        Joi.string().valid(...Object.values(ApiWaveParticipationRequirement))
      )
      .optional()
      .default([]),
    signature_required: Joi.boolean().optional().default(false),
    period: IntRangeSchema.required().allow(null),
    terms: Joi.string().optional().allow(null).default(null),
    submission_strategy: WaveUpdateParticipationSubmissionStrategySchema
  });

export const WaveChatSchema = Joi.object<ApiCreateNewWaveChatConfig>({
  scope: WaveScopeSchema.required(),
  enabled: Joi.boolean().optional().default(true),
  slow_mode_cooldown_ms: Joi.number()
    .integer()
    .optional()
    .min(Time.seconds(1).toMillis()),
  links_disabled: Joi.boolean().optional()
});

function createWaveDecisionsStrategySchema({
  requireFutureFirstDecisionTime
}: {
  requireFutureFirstDecisionTime: boolean;
}): Joi.ObjectSchema<ApiWaveDecisionsStrategy> {
  const firstDecisionTimeSchema = requireFutureFirstDecisionTime
    ? Joi.number()
        .integer()
        .required()
        .custom((value, helpers) => {
          if (value <= Time.currentMillis()) {
            return helpers.error('firstDecisionTime.future');
          }
          return value;
        }, 'future time check')
        .messages({
          'firstDecisionTime.future':
            'first_decision_time must be in the future'
        })
    : Joi.number().integer().required();

  return Joi.object<ApiWaveDecisionsStrategy>({
    first_decision_time: firstDecisionTimeSchema,
    subsequent_decisions: Joi.array()
      .required()
      .items(Joi.number().integer().min(Time.hours(1).toMillis())),
    is_rolling: Joi.boolean().required()
  });
}

export const CreateWaveDecisionsStrategySchema =
  createWaveDecisionsStrategySchema({
    requireFutureFirstDecisionTime: true
  });

const UpdateWaveDecisionsStrategySchema = createWaveDecisionsStrategySchema({
  requireFutureFirstDecisionTime: false
});

function createWaveConfigSchema(
  decisionsStrategySchema: Joi.ObjectSchema<ApiWaveDecisionsStrategy>
): Joi.ObjectSchema<
  ApiWaveConfig & {
    period?: ApiIntRange | null;
    winning_thresholds?: unknown[] | null;
  }
> {
  return Joi.object<
    ApiWaveConfig & {
      period?: ApiIntRange | null;
      winning_thresholds?: unknown[] | null;
    }
  >({
    type: Joi.string()
      .required()
      .valid(...Object.values(ApiWaveType)),
    // Accept the legacy field from old clients and strip it before service code.
    winning_thresholds: Joi.alternatives()
      .try(Joi.array(), Joi.valid(null))
      .optional()
      .strip(),
    winning_threshold: Joi.when('type', {
      is: Joi.string().valid(ApiWaveType.Approve),
      then: Joi.number().integer().required().min(1),
      otherwise: Joi.valid(null).default(null)
    }),
    winning_threshold_min_duration_ms: Joi.when('type', {
      is: Joi.string().valid(ApiWaveType.Approve),
      then: Joi.number().integer().optional().allow(null).min(0).default(0),
      otherwise: Joi.valid(null).optional().default(null)
    }),
    max_winners: Joi.when('type', {
      is: Joi.string().valid(ApiWaveType.Approve),
      then: Joi.number().integer().required().allow(null).min(1),
      otherwise: Joi.valid(null).default(null)
    }),
    max_votes_per_identity_to_drop: Joi.when('type', {
      is: Joi.string().valid(ApiWaveType.Approve, ApiWaveType.Rank),
      then: Joi.number().integer().optional().allow(null).min(1),
      otherwise: Joi.valid(null).optional()
    }),
    time_lock_ms: Joi.number()
      .integer()
      .required()
      .allow(null)
      .min(Time.minutes(5).toMillis()),
    period: IntRangeSchema.optional(),
    admin_group: WaveScopeSchema.required(),
    decisions_strategy: decisionsStrategySchema.optional().allow(null),
    admin_drop_deletion_enabled: Joi.boolean().optional().default(false)
  });
}

const WaveConfigSchema = createWaveConfigSchema(
  CreateWaveDecisionsStrategySchema
);

export const UpdateWaveConfigSchema = createWaveConfigSchema(
  UpdateWaveDecisionsStrategySchema
);

const WaveOutcomeDistributionItemSchema =
  Joi.object<ApiWaveOutcomeDistributionItem>({
    amount: Joi.number().integer().optional().min(0).allow(null),
    description: Joi.string().optional().min(1).max(500).allow(null)
  });

export const WaveOutcomeSchema = Joi.object<ApiCreateWaveOutcome>({
  type: Joi.string()
    .required()
    .valid(...Object.values(ApiWaveOutcomeType)),
  subtype: Joi.when('type', {
    is: ApiWaveOutcomeType.Automatic,
    then: Joi.string()
      .required()
      .valid(...Object.values(ApiWaveOutcomeSubType)),
    otherwise: Joi.optional().valid(null)
  }),
  description: Joi.string().required().max(250).min(1),
  credit: Joi.when('subtype', {
    is: ApiWaveOutcomeSubType.CreditDistribution,
    then: Joi.string()
      .required()
      .valid(...Object.values(ApiWaveOutcomeCredit)),
    otherwise: Joi.optional().valid(null)
  }),
  rep_category: Joi.when('credit', {
    is: ApiWaveOutcomeCredit.Rep,
    then: Joi.string()
      .required()
      .min(3)
      .max(100)
      .regex(REP_CATEGORY_PATTERN)
      .messages({
        'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
      }),
    otherwise: Joi.optional().valid(null)
  }),
  amount: Joi.when('subtype', {
    is: ApiWaveOutcomeSubType.CreditDistribution,
    then: Joi.number().integer().required().min(1),
    otherwise: Joi.optional().valid(null)
  }),
  distribution: Joi.array()
    .items(WaveOutcomeDistributionItemSchema)
    .optional()
    .default([])
});

const waveSchemaBaseValidations = {
  name: Joi.string().required().max(250).min(1),
  picture: Joi.string()
    .optional()
    .allow(null)
    .regex(/^https:\/\/d3lqz0a4bldqgf.cloudfront.net\//),
  voting: WaveVotingSchema.required(),
  visibility: WaveVisibilitySchema.required(),
  participation: WaveParticipationSchema.required(),
  chat: WaveChatSchema.optional().default({
    scope: { group_id: null },
    enabled: true
  }),
  wave: WaveConfigSchema.required()
};

export const WaveSchema = Joi.object<ApiCreateNewWave>({
  ...waveSchemaBaseValidations,
  parent_wave_id: Joi.string().optional().allow(null).default(null),
  description_drop: NewWaveDropSchema.required(),
  outcomes: Joi.array().required().min(0).items(WaveOutcomeSchema)
});

export const UpdateWaveSchema = Joi.object<ApiUpdateWaveRequest>({
  ...waveSchemaBaseValidations,
  participation: UpdateWaveParticipationSchema.required(),
  wave: UpdateWaveConfigSchema.required()
});
