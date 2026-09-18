import type { MembershipPrimaryContext } from './membership-primary';
import type { MembershipRefreshTargetKey } from './membership-validation';
import type { MembershipDeliveryDescriptor } from './membership-worker.types';

export const MEMBERSHIP_DISPATCH_CHECKPOINT_ID = 'membership-dispatch-v1';
export type MembershipDispatchLane = 'DUE' | 'TARGET_PK';
export interface MembershipDispatchRawKey {
  scope: string;
  target_id: string;
}
export interface MembershipDispatchDueKey extends MembershipDispatchRawKey {
  available_at_millis: string;
}
export interface MembershipDispatchProgress {
  next_lane: MembershipDispatchLane;
  due: {
    sweep: string;
    cutoff_millis: string | null;
    through: MembershipDispatchDueKey | null;
    after: MembershipDispatchDueKey | null;
  };
  target_pk: {
    sweep: string;
    through: MembershipDispatchRawKey | null;
    after: MembershipDispatchRawKey | null;
  };
}
export interface MembershipDispatchPosition {
  lane: MembershipDispatchLane;
  key: MembershipDispatchRawKey | null;
  exhausted: boolean;
}
export interface MembershipDispatchHint {
  target: MembershipRefreshTargetKey;
  delivery: MembershipDeliveryDescriptor;
}
export type MembershipDispatchSender = (
  hint: MembershipDispatchHint,
  budget: { deadline_monotonic_millis: number; signal: AbortSignal }
) => Promise<void>;
/** Closed fixture policy, evaluated only inside the exact target transaction. */
export type MembershipDispatchHeldTargetGuard = (
  target: MembershipRefreshTargetKey,
  ctx: MembershipPrimaryContext
) => Promise<boolean>;

export interface MembershipDispatchOptions {
  deadline_monotonic_millis: number;
  control_millis: number;
  target_millis: number;
  send_millis: number;
  cleanup_reserve_millis: number;
  max_statement_millis: number;
  finalization_reserve_millis: number;
  lock_wait_seconds: number;
  reservation_millis: number;
  max_candidates: number;
  max_per_lane: number;
  /** Reserve FULL directly before the bounded keyset lanes. */
  prioritize_full?: boolean;
}
export type MembershipDispatchSkip =
  | 'MISSING'
  | 'INVALID_TARGET'
  | 'INTEGRITY'
  | 'SETTLED'
  | 'PARKED'
  | 'FUTURE'
  | 'LIVE_LEASE'
  | 'FIXTURE_HELD'
  | 'LOCK_BUSY';
export type MembershipDispatchReservation = (
  | { outcome: 'RESERVED'; hint: MembershipDispatchHint }
  | { outcome: MembershipDispatchSkip }
) & { observed_due_age_millis: number };
export interface MembershipDispatchResult {
  raw_candidates: number;
  due_candidates: number;
  target_pk_candidates: number;
  sent: number;
  skipped: number;
  send_failed: number;
  control_busy: boolean;
  budget_exhausted: boolean;
  /** Maximum age among bounded locked observations, not a full-table census. */
  oldest_due_age_millis: number;
  /** Parked candidates observed during this pass, not the global parked count. */
  parked_seen: number;
  /** Counts only; never expose run lease tokens or raw malformed identifiers. */
  outcomes: Partial<
    Record<
      | MembershipDispatchSkip
      | 'EMPTY'
      | 'SEND_FAILED'
      | 'SENT'
      | 'DUPLICATE_TARGET',
      number
    >
  >;
}
export class MembershipDispatchIntegrityError extends Error {
  readonly code = 'DISPATCH_INTEGRITY';
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, MembershipDispatchIntegrityError.prototype);
  }
}
