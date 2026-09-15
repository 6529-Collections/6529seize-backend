import type {
  ActiveInputV1,
  MembershipInputLimits
} from './membership-evaluator.types';
import type { MembershipRefreshRunEntity } from '@/entities/IMembershipRefreshRun';
import type { MembershipRefreshTargetKey } from './membership-validation';

export interface MembershipRetirement {
  retired_at_millis: string;
  after_group_id: string | null;
}

interface CursorBase {
  phase: 'SCAN' | 'READY_TO_FINISH' | 'DONE';
  after_id: string | null;
  through_id: string | null;
  traversal_collation: string;
  gc?: MembershipRetirement;
}

export interface MembershipProfileCursorV2 extends CursorBase {
  protocol_version: 2;
  kind: 'PROFILE';
  identity_consolidation_key: string;
  active_input: ActiveInputV1 | null;
}

export interface MembershipFanoutCursorV1 extends CursorBase {
  protocol_version: 1;
  kind: 'PROFILE_FANOUT';
}

export type MembershipWorkerCursor =
  | MembershipProfileCursorV2
  | MembershipFanoutCursorV1;
export type MembershipWorkerRun = Omit<
  MembershipRefreshRunEntity,
  'progress_cursor'
> & {
  readonly progress_cursor: MembershipWorkerCursor;
};

/** Internal DB authority. Never put a token in a queue hint or diagnostic output. */
export interface MembershipWorkerClaim {
  readonly target: MembershipRefreshTargetKey;
  readonly run_id: string;
  readonly lease_token: string;
  readonly checkpoint_version: string;
}

/** Delivery suppression only; DB lease tokens remain private authority. */
export interface MembershipDeliveryDescriptor {
  readonly requested_version: string;
  readonly reserved_until_millis: string;
}

export interface MembershipWorkerOptions {
  readonly deadline_monotonic_millis: number;
  readonly transaction_millis: number;
  readonly max_statement_millis: number;
  readonly finalization_reserve_millis: number;
  readonly checkpoint_reserve_millis: number;
  readonly lock_wait_seconds: number;
  readonly lease_millis: number;
  readonly max_quanta: number;
  readonly page_size: number;
  readonly input_limits: MembershipInputLimits;
  readonly retry_millis: number;
  readonly max_attempts: number;
}

export type MembershipWorkerOutcome =
  | 'NO_WORK'
  | 'PENDING'
  | 'COMPLETED'
  | 'SUPERSEDED'
  | 'FAILED';
export interface MembershipWorkerResult {
  readonly outcome: MembershipWorkerOutcome;
  readonly run_id: string | null;
  readonly checkpoint_version: string | null;
  readonly quanta: number;
  readonly processed_count: string;
  /** Evaluator-reported input queries; excludes worker guards and transaction SQL. */
  readonly query_count: number;
  /** Evaluator input rows, or raw fanout profiles; not physical rows examined. */
  readonly input_rows: number;
}

export type MembershipWorkerErrorCode =
  | 'FENCED'
  | 'INTEGRITY'
  | 'SOURCE_CHANGED'
  | 'SOURCE_NOT_READY'
  | 'EXPIRED'
  | 'INVALID_INPUT';
export class MembershipWorkerError extends Error {
  constructor(
    readonly code: MembershipWorkerErrorCode,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, MembershipWorkerError.prototype);
  }
}
