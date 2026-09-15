import { MembershipPrimaryContext } from './membership-primary';
import { MembershipSourceVersion } from './membership-schema.types';

/** Captured once; later pages may not advance the catalogue version or time. */
export interface MembershipProfileEvaluationSeed {
  readonly profile_id: string;
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

/** Only a fully evaluated bounded page is a result. Unknown/timeout must throw. */
export interface MembershipProfilePageResult {
  readonly eligible_group_ids: readonly string[];
  readonly scanned_count: number;
  readonly after_group_id: string | null;
  readonly done: boolean;
  /** Minimum future boundary across all evaluated rules, including false rules. */
  readonly valid_until_millis: string | null;
  readonly query_count: number;
  readonly input_rows: number;
}

/** Worker owns atomic candidate writes, checkpointing and final locking publication. */
export interface MembershipProfileEvaluator {
  captureProfile(
    profileId: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipProfileEvaluationSeed>;
  evaluatePage(
    input: MembershipProfilePageInput,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipProfilePageResult>;
}
