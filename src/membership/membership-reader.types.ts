import type { MembershipPrimaryContext } from './membership-primary';

export type MembershipFallbackReason =
  | 'candidate_cap'
  | 'publication_missing'
  | 'publication_invalid'
  | 'identity_missing'
  | 'identity_changed'
  | 'catalogue_unready'
  | 'group_version_missing'
  | 'group_changed'
  | 'source_unready'
  | 'source_changed'
  | 'time_boundary'
  | 'generation_range';

export interface MembershipScopedReadResult {
  readonly eligible_group_ids: string[];
  readonly candidate_count: number;
  readonly coverage_complete: boolean;
  readonly materialized_count: number;
  readonly direct_count: number;
  readonly direct_duration_ms: number;
  readonly shadow_duration_ms: number | null;
  readonly fallback_reasons: Partial<Record<MembershipFallbackReason, number>>;
  /** Full primary direct result at the same snapshot for controlled comparison. */
  readonly shadow_direct_group_ids: string[] | null;
  readonly shadow_equal: boolean | null;
}

export type MembershipCandidateIds = (
  ctx: MembershipPrimaryContext
) => Promise<readonly string[]>;
export type MembershipDirectEvaluator = (
  profileId: string,
  groupIds: readonly string[],
  ctx: MembershipPrimaryContext
) => Promise<readonly string[]>;
