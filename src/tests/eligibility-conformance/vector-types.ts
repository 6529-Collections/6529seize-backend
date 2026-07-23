/**
 * JSON schema (as TypeScript types) of the golden eligibility conformance
 * vectors in `src/tests/eligibility-conformance/vectors/*.json`.
 *
 * Each vector is a self-contained scenario: one subject profile with its
 * full relevant state, a set of group rules (full `UserGroupEntity` field
 * coverage via defaults) and the spec-normative expectation. Every id in a
 * vector (identities, groups, profile groups, grants) is symbolic; the
 * loader (`vector-loader.ts`) materializes them into concrete database
 * entities.
 *
 * The normative behavior is defined by `docs/eligibility-spec.md`
 * (spec_version 2). Both production engines must match every vector.
 */

export type VectorCollection = 'memes' | 'gradient' | 'lab' | 'nextgen';

export type VectorMatter = 'REP' | 'CIC' | 'WAVE_REP';

export type VectorDirection = 'RECEIVED' | 'SENT';

export type VectorMatchMode = 'ANY_TOKEN' | 'ALL_TOKENS';

export type VectorTdhStrategy = 'TDH' | 'XTDH' | 'BOTH';

export type VectorGrantTokenMode = 'ALL' | 'INCLUDE';

export type VectorGrantStatus = 'GRANTED' | 'PENDING' | 'FAILED' | 'DISABLED';

export interface VectorIdentityState {
  /** Symbolic identity id, unique within the vector. */
  readonly id: string;
  readonly tdh?: number;
  readonly xtdh?: number;
  readonly level_raw?: number;
  readonly rep?: number;
  readonly cic?: number;
  /**
   * Number of additional consolidated wallets besides the primary one.
   * All wallets share the identity's consolidation key.
   */
  readonly extra_wallets?: number;
}

export interface VectorRating {
  readonly rater: string;
  readonly target: string;
  readonly matter: VectorMatter;
  /** Required for REP/WAVE_REP; CIC defaults to the 'CIC' category. */
  readonly category?: string;
  readonly rating: number;
}

export interface VectorNftOwning {
  readonly owner: string;
  readonly collection: VectorCollection;
  readonly token_id: string;
  /** Which of the owner's wallets holds the token (0 = primary). */
  readonly wallet_index?: number;
}

export interface VectorProfileGroup {
  /** Symbolic profile-group (identity list) id. */
  readonly id: string;
  readonly members: string[];
}

export interface VectorGrant {
  /** Symbolic grant id. */
  readonly id: string;
  readonly token_mode: VectorGrantTokenMode;
  /** Defaults to GRANTED. */
  readonly status?: VectorGrantStatus;
  /** Token set for INCLUDE-mode grants. */
  readonly tokens?: string[];
}

export interface VectorExternalOwnership {
  /** Symbolic grant id whose target partition this ownership row is in. */
  readonly grant: string;
  readonly token_id: string;
  readonly owner: string;
}

/**
 * Group rule. Field names mirror `UserGroupEntity` columns; omitted fields
 * take the entity defaults (null bounds, false flags, ALL_TOKENS nft match
 * mode, ANY_TOKEN grant match mode, TDH inclusion strategy, visible=true).
 * `rep_user`/`cic_user` reference symbolic identity ids;
 * `profile_group_id`/`excluded_profile_group_id` reference symbolic
 * profile-group ids; `is_beneficiary_of_grant_id` references a symbolic
 * grant id. `owns_*_tokens` are plain string arrays (the loader stores them
 * as the JSON strings the entity expects).
 */
export interface VectorGroup {
  readonly id: string;
  readonly visible?: boolean;
  readonly tdh_min?: number | null;
  readonly tdh_max?: number | null;
  readonly tdh_inclusion_strategy?: VectorTdhStrategy;
  readonly level_min?: number | null;
  readonly level_max?: number | null;
  readonly rep_min?: number | null;
  readonly rep_max?: number | null;
  readonly rep_user?: string | null;
  readonly rep_direction?: VectorDirection | null;
  readonly rep_category?: string | null;
  readonly cic_min?: number | null;
  readonly cic_max?: number | null;
  readonly cic_user?: string | null;
  readonly cic_direction?: VectorDirection | null;
  readonly owns_meme?: boolean;
  readonly owns_meme_tokens?: string[] | null;
  readonly owns_meme_tokens_match_mode?: VectorMatchMode;
  readonly owns_gradient?: boolean;
  readonly owns_gradient_tokens?: string[] | null;
  readonly owns_gradient_tokens_match_mode?: VectorMatchMode;
  readonly owns_lab?: boolean;
  readonly owns_lab_tokens?: string[] | null;
  readonly owns_lab_tokens_match_mode?: VectorMatchMode;
  readonly owns_nextgen?: boolean;
  readonly owns_nextgen_tokens?: string[] | null;
  readonly owns_nextgen_tokens_match_mode?: VectorMatchMode;
  readonly profile_group_id?: string | null;
  readonly excluded_profile_group_id?: string | null;
  readonly is_beneficiary_of_grant_id?: string | null;
  readonly is_beneficiary_of_grant_match_mode?: VectorMatchMode;
}

export interface EligibilityConformanceVector {
  /** Globally unique kebab-case vector name. */
  readonly name: string;
  /** Rule dimension bucket (tdh, level, rep, cic, nft, grants, lists, composite). */
  readonly dimension: string;
  readonly description: string;
  readonly identities: VectorIdentityState[];
  /** Symbolic id of the profile under test. */
  readonly subject: string;
  readonly profile_groups?: VectorProfileGroup[];
  readonly ratings?: VectorRating[];
  readonly nft_ownings?: VectorNftOwning[];
  readonly grants?: VectorGrant[];
  readonly external_ownership?: VectorExternalOwnership[];
  readonly groups: VectorGroup[];
  /** Spec-normative outcome (symbolic group ids), order-insensitive. */
  readonly expected: {
    readonly eligible_group_ids: string[];
  };
}
