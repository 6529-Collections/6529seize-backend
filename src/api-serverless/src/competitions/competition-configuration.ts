import * as Joi from 'joi';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import {
  UpdateWaveConfigSchema,
  WaveOutcomeSchema,
  WaveParticipationSchema,
  WaveVotingSchema
} from '@/api/waves/wave-write.schemas';
import { WaveEntity } from '@/entities/IWave';
import { CompetitionEntity, CompetitionType } from '@/entities/ICompetition';

export const competitionPresentationKeys = [
  'wave_display.approve.tabs.approvals_label',
  'wave_display.approve.tabs.approved_label',
  'wave_display.submission.button_label',
  'wave_display.proposals.card_recipe',
  'wave_display.proposals.compact',
  'wave_display.rules.custom',
  'wave_display.outcomes.visible'
];

export const CompetitionDraftSchema = Joi.object<ApiCompetitionDraftInput>({
  title: Joi.string().trim().min(1).max(250).required(),
  description: Joi.string().max(50000).allow(null, '').required(),
  participation: WaveParticipationSchema.fork(['period'], (schema) =>
    schema.optional().default({ min: null, max: null })
  ).required(),
  voting: WaveVotingSchema.fork(['period'], (schema) =>
    schema.optional().default({ min: null, max: null })
  ).required(),
  rules: UpdateWaveConfigSchema.fork(
    [
      'admin_group',
      'admin_drop_deletion_enabled',
      'period',
      'winning_thresholds'
    ],
    () => Joi.any().forbidden()
  )
    .fork(['decisions_strategy'], (schema) => schema.required())
    .keys({ type: Joi.string().valid('RANK', 'APPROVE').required() })
    .required(),
  outcomes: Joi.array().items(WaveOutcomeSchema).max(100).required(),
  presentation: Joi.array()
    .items(
      Joi.object({
        data_key: Joi.string()
          .valid(...competitionPresentationKeys)
          .required(),
        data_value: Joi.string().allow('').max(50000).required()
      })
    )
    .max(30)
    .unique('data_key')
    .required()
}).unknown(false);

/** Reuse all legacy configuration relation rules without persisting a fake wave. */
export function competitionValidationWave(
  input: ApiCompetitionDraftInput,
  wave: WaveEntity
): ApiCreateNewWave {
  return {
    name: input.title,
    picture: null,
    description_drop: {
      parts: [],
      referenced_nfts: [],
      mentioned_users: [],
      metadata: [],
      signature: null
    },
    participation: input.participation,
    voting: input.voting,
    visibility: { scope: { group_id: wave.visibility_group_id } },
    chat: {
      enabled: wave.chat_enabled,
      scope: { group_id: wave.chat_group_id }
    },
    wave: {
      ...input.rules,
      type: input.rules.type as unknown as ApiWaveType,
      admin_group: { group_id: wave.admin_group_id },
      admin_drop_deletion_enabled: wave.admin_drop_deletion_enabled
    },
    outcomes: input.outcomes
  };
}

export function configurationToRecord(
  input: ApiCompetitionDraftInput,
  previous: CompetitionEntity
): CompetitionEntity {
  return {
    ...previous,
    title: input.title,
    description: input.description,
    type: input.rules.type as unknown as CompetitionType,
    presentation_config: input.presentation,
    participation_config: {
      group_id: input.participation.scope.group_id,
      signature_required: input.participation.signature_required,
      max_entries_per_participant:
        input.participation.no_of_applications_allowed_per_participant,
      required_metadata: input.participation.required_metadata,
      required_media: input.participation.required_media,
      submission_type: input.participation.submission_strategy?.type ?? null,
      identity_submission_strategy:
        input.participation.submission_strategy?.config.who_can_be_submitted ??
        null,
      identity_submission_duplicates:
        input.participation.submission_strategy?.config.duplicates ?? null,
      starts_at: input.participation.period?.min ?? null,
      ends_at: input.participation.period?.max ?? null,
      terms: input.participation.terms
    },
    voting_config: {
      group_id: input.voting.scope.group_id,
      credit_type: input.voting.credit_type,
      credit_scope: input.voting.credit_scope ?? 'WAVE',
      credit_category: input.voting.credit_category ?? null,
      credit_creditor: input.voting.creditor_id ?? null,
      credit_nfts: input.voting.credit_nfts ?? [],
      signature_required: input.voting.signature_required ?? false,
      starts_at: input.voting.period?.min ?? null,
      ends_at: input.voting.period?.max ?? null,
      max_votes_per_identity_to_entry:
        input.rules.max_votes_per_identity_to_drop,
      forbid_negative_votes: input.voting.forbid_negative_votes ?? false
    },
    decision_config: {
      strategy: input.rules.decisions_strategy,
      next_decision_time:
        input.rules.decisions_strategy?.first_decision_time ?? null,
      winning_min_threshold: input.rules.winning_threshold,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms:
        input.rules.winning_threshold_min_duration_ms ?? 0,
      max_winners: input.rules.max_winners,
      time_lock_ms: input.rules.time_lock_ms
    },
    winner_config: {
      max_winners: input.rules.max_winners,
      winning_min_threshold: input.rules.winning_threshold,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms:
        input.rules.winning_threshold_min_duration_ms ?? 0
    },
    outcome_config: input.outcomes,
    participation_starts_at: input.participation.period?.min ?? null,
    participation_ends_at: input.participation.period?.max ?? null,
    voting_starts_at: input.voting.period?.min ?? null,
    voting_ends_at: input.voting.period?.max ?? null
  };
}
