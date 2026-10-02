import { Competition } from './competition.types';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { CompetitionDraftSchema } from '@/api/competitions/competition-configuration';

/** Append a native command snapshot at transfer; never rewrite legacy versions
 * or the version associated with an accepted entry. Unsupported legacy rule
 * shapes fail closed and retain their guarded legacy owner. */
export function migrationCommandConfiguration(
  c: Competition
): ApiCompetitionDraftInput {
  if (c.decisions.winning_max_threshold !== null)
    throw new Error(
      'OWNED_EXCEPTION: legacy threshold range requires an owned native command adapter'
    );
  const value = {
    title: c.title,
    description: c.description,
    participation: {
      scope: { group_id: c.participation.group_id },
      signature_required: c.participation.signature_required,
      no_of_applications_allowed_per_participant:
        c.participation.max_entries_per_participant,
      required_metadata: c.participation.required_metadata,
      required_media: c.participation.required_media,
      terms: c.participation.terms,
      period: { min: c.participation.starts_at, max: c.participation.ends_at },
      submission_strategy:
        c.participation.submission_type === null
          ? null
          : {
              type: c.participation.submission_type,
              config: {
                who_can_be_submitted:
                  c.participation.identity_submission_strategy,
                duplicates: c.participation.identity_submission_duplicates
              }
            }
    },
    voting: {
      scope: { group_id: c.voting.group_id },
      credit_type: c.voting.credit_type,
      credit_scope: c.voting.credit_scope,
      credit_category: c.voting.credit_category,
      creditor_id: c.voting.credit_creditor,
      credit_nfts:
        c.voting.credit_type === 'CARD_SET_TDH' ? c.voting.credit_nfts : null,
      signature_required: c.voting.signature_required,
      forbid_negative_votes: c.voting.forbid_negative_votes,
      period: { min: c.voting.starts_at, max: c.voting.ends_at }
    },
    rules: {
      type: c.type,
      winning_threshold: c.decisions.winning_min_threshold,
      winning_threshold_min_duration_ms:
        c.type === 'APPROVE'
          ? c.decisions.winning_threshold_min_duration_ms
          : null,
      max_winners: c.decisions.max_winners,
      max_votes_per_identity_to_drop: c.voting.max_votes_per_identity_to_entry,
      time_lock_ms: c.decisions.time_lock_ms,
      decisions_strategy: c.decisions.strategy
    },
    outcomes: (c.outcome_config as readonly Record<string, unknown>[]).map(
      (outcome) => ({
        type: outcome.type,
        subtype: outcome.subtype,
        description: outcome.description,
        credit: outcome.credit,
        rep_category: outcome.rep_category,
        amount: outcome.amount,
        distribution: Array.isArray(outcome.distribution)
          ? outcome.distribution
          : []
      })
    ),
    presentation: []
  };
  const result = CompetitionDraftSchema.validate(value);
  if (result.error)
    throw new Error(
      `OWNED_EXCEPTION: legacy rule shape requires an owned native command adapter (${result.error.details.map((detail) => detail.path.join('.')).join(',')})`
    );
  return result.value as ApiCompetitionDraftInput;
}
