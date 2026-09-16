import type { MembershipPrimaryContext } from '@/membership/membership-primary';
import type { MembershipSourceVersion } from '@/membership/membership-schema.types';

export interface MembershipProfileEvaluationSeed {
  readonly profile_id: string;
  readonly identity_consolidation_key: string;
  readonly spec_version: number;
  readonly source_versions: readonly MembershipSourceVersion[];
  readonly catalog_version: string;
  readonly evaluation_time_millis: string;
  readonly through_group_id: string | null;
}
export interface MembershipProfilePageInput extends MembershipProfileEvaluationSeed {
  readonly after_group_id: string | null;
  readonly max_scanned_groups: number;
  readonly max_query_millis: number;
  readonly deadline_monotonic_millis: number;
}
export interface MembershipInputLimits {
  readonly max_queries: number;
  readonly max_input_rows: number;
  readonly max_input_bytes: number;
  readonly max_windows: number;
  readonly raw_window: number;
}
export type InputStage =
  | {
      kind: 'LISTS';
      after_list_id: string | null;
      included: boolean;
      excluded: boolean;
    }
  | { kind: 'SCALARS' }
  | {
      kind: 'RATING';
      axis: 'CIC' | 'REP';
      after: { category: string | null; other_profile_id: string | null };
      signed_sum: string;
      matching_count: string;
    }
  | {
      kind: 'NFT_REQUIREMENT';
      contract_slot: number;
      next_json_index: string;
      current_token: string | null;
      after_owner_wallet: string | null;
    }
  | {
      kind: 'NFT_ANY';
      contract_slot: number;
      wallets: { after_wallet: string | null };
    }
  | {
      kind: 'GRANT_INCLUDE';
      after_token_id: string | null;
      selected_count: string;
      owned_count: string;
    }
  | { kind: 'GRANT_ALL_ANY'; wallets: { after_wallet: string | null } };
export interface ActiveInputV1 {
  protocol_version: 1;
  seed_fingerprint: string;
  group_id: string;
  group_version: string;
  scalar_plan_fingerprint: string;
  grant_metadata_fingerprint: string | null;
  valid_until_millis: string | null;
  stage: InputStage;
}
export interface MembershipEvaluationQuantumInput extends MembershipProfilePageInput {
  readonly active_input: ActiveInputV1 | null;
  readonly limits: MembershipInputLimits;
}
export interface MembershipProfilePageResult {
  readonly eligible_group_ids: readonly string[];
  readonly scanned_count: number;
  readonly after_group_id: string | null;
  readonly done: boolean;
  readonly valid_until_millis: string | null;
  readonly query_count: number;
  readonly input_rows: number;
}
export type MembershipEvaluationQuantumResult =
  | (MembershipProfilePageResult & {
      readonly kind: 'INPUT_PENDING';
      readonly active_input: ActiveInputV1;
      readonly done: false;
    })
  | (MembershipProfilePageResult & {
      readonly kind: 'PAGE_COMPLETE';
      readonly active_input: null;
    });
export interface MembershipProfileEvaluator {
  captureProfile(
    profileId: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipProfileEvaluationSeed>;
  evaluateQuantum(
    input: MembershipEvaluationQuantumInput,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipEvaluationQuantumResult>;
}
export type MembershipEvaluationErrorCode =
  | 'SOURCE_CHANGED'
  | 'IDENTITY_NOT_FOUND'
  | 'INTEGRITY'
  | 'INVALID_INPUT'
  | 'RESOURCE_LIMIT'
  | 'EXPIRED'
  | 'NUMERIC_DOMAIN_UNSUPPORTED';
export class MembershipEvaluationError extends Error {
  constructor(
    readonly code: MembershipEvaluationErrorCode,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, MembershipEvaluationError.prototype);
  }
}
