import type {
  ParticipationRequiredMedia,
  WaveBaseType,
  WaveDecisionStrategy,
  WaveCreditScope,
  WaveCreditType,
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveRequiredMetadataItem,
  WaveSubmissionType
} from '@/entities/IWave';

/** Live shared-hub policies. Competition entry/vote rules remain separately
 * owned by each native competition, including the immutable original primary. */
export interface NativeWaveHubParticipationConfig {
  readonly group_id: string | null;
  readonly signature_required: boolean;
  readonly max_entries_per_participant: number | null;
  readonly required_metadata: readonly WaveRequiredMetadataItem[];
  readonly required_media: readonly ParticipationRequiredMedia[];
  readonly submission_type: WaveSubmissionType | null;
  readonly identity_submission_strategy: WaveIdentitySubmissionStrategy | null;
  readonly identity_submission_duplicates: WaveIdentitySubmissionDuplicates | null;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly terms: string | null;
}

export interface NativeWaveHubVotingConfig {
  /** Current hub metadata, including existing CHAT strategies exposed by GETs.
   * Missing in policies written before this additive field means null. */
  readonly decision_strategy?: WaveDecisionStrategy | null;
  readonly group_id: string | null;
  readonly credit_type: WaveCreditType;
  readonly credit_scope: WaveCreditScope;
  readonly credit_category: string | null;
  readonly credit_creditor: string | null;
  readonly signature_required: boolean;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly max_votes_per_identity_to_entry: number | null;
  readonly forbid_negative_votes: boolean;
  readonly time_lock_ms: number | null;
  readonly credit_nfts: readonly { contract: string; token_id: number }[];
}

export const WAVE_HUB_PARTICIPATION_FIELDS = {
  participation_group_id: 'group_id',
  participation_signature_required: 'signature_required',
  participation_max_applications_per_participant: 'max_entries_per_participant',
  participation_required_metadata: 'required_metadata',
  participation_required_media: 'required_media',
  submission_type: 'submission_type',
  identity_submission_strategy: 'identity_submission_strategy',
  identity_submission_duplicates: 'identity_submission_duplicates',
  participation_period_start: 'starts_at',
  participation_period_end: 'ends_at',
  participation_terms: 'terms'
} as const;

export const WAVE_HUB_VOTING_FIELDS = {
  voting_group_id: 'group_id',
  voting_credit_type: 'credit_type',
  voting_credit_scope: 'credit_scope',
  voting_credit_category: 'credit_category',
  voting_credit_creditor: 'credit_creditor',
  voting_signature_required: 'signature_required',
  voting_period_start: 'starts_at',
  voting_period_end: 'ends_at',
  max_votes_per_identity_to_drop: 'max_votes_per_identity_to_entry',
  forbid_negative_votes: 'forbid_negative_votes',
  time_lock_ms: 'time_lock_ms'
} as const;

type ConfigurationSource = Pick<
  WaveBaseType,
  | keyof typeof WAVE_HUB_PARTICIPATION_FIELDS
  | keyof typeof WAVE_HUB_VOTING_FIELDS
  | 'decisions_strategy'
> & {
  readonly voting_credit_nfts?:
    | readonly {
        contract: string;
        tokenId: number;
      }[]
    | null;
};

function configurationArray<T>(value: readonly T[] | string): readonly T[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed))
    throw new Error('Native hub configuration requires an array');
  return parsed;
}

export function waveHubConfigurationFromWave(wave: ConfigurationSource): {
  participation: NativeWaveHubParticipationConfig;
  voting: NativeWaveHubVotingConfig;
} {
  return {
    participation: {
      group_id: wave.participation_group_id,
      signature_required: wave.participation_signature_required,
      max_entries_per_participant:
        wave.participation_max_applications_per_participant,
      required_metadata: configurationArray(
        wave.participation_required_metadata
      ),
      required_media: configurationArray(wave.participation_required_media),
      submission_type: wave.submission_type,
      identity_submission_strategy: wave.identity_submission_strategy,
      identity_submission_duplicates: wave.identity_submission_duplicates,
      starts_at: wave.participation_period_start,
      ends_at: wave.participation_period_end,
      terms: wave.participation_terms
    },
    voting: {
      decision_strategy: wave.decisions_strategy,
      group_id: wave.voting_group_id,
      credit_type: wave.voting_credit_type,
      credit_scope: wave.voting_credit_scope,
      credit_category: wave.voting_credit_category,
      credit_creditor: wave.voting_credit_creditor,
      signature_required: wave.voting_signature_required,
      starts_at: wave.voting_period_start,
      ends_at: wave.voting_period_end,
      max_votes_per_identity_to_entry: wave.max_votes_per_identity_to_drop,
      forbid_negative_votes: wave.forbid_negative_votes,
      time_lock_ms: wave.time_lock_ms,
      credit_nfts: (wave.voting_credit_nfts ?? []).map((nft) => ({
        contract: nft.contract,
        token_id: nft.tokenId
      }))
    }
  };
}

/** Serialize only command-owned typed policies, never a row or compatibility
 * snapshot. The same values are written to its legitimate archive revision. */
export function serializeWaveHubConfiguration(wave: ConfigurationSource): {
  hub_participation_config: string;
  hub_voting_config: string;
} {
  const configuration = waveHubConfigurationFromWave(wave);
  return {
    hub_participation_config: JSON.stringify(configuration.participation),
    hub_voting_config: JSON.stringify(configuration.voting)
  };
}
