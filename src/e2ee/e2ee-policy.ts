import {
  DirectMessageAdmission,
  DirectMessageRefusalReason
} from '@/direct-messages/direct-message-admission';

// "Caller adds or claims target" policy (D109 contract v1, section 7.1). The
// admission rules themselves (blocks, DM policy, group membership) are the
// platform's shared ones in DirectMessageAdmissionService; this module only
// maps an admission decision plus device availability to an E2EE status.

export enum E2eeEligibilityStatus {
  OK = 'OK',
  POLICY = 'POLICY',
  /** Only the caller's own block of the target. Never the target's block. */
  BLOCKED = 'BLOCKED',
  NO_DEVICES = 'NO_DEVICES'
}

export interface E2eeEligibilityDecision {
  readonly status: E2eeEligibilityStatus;
  /** Why admission refused, for POLICY and BLOCKED; otherwise null. */
  readonly reason: DirectMessageRefusalReason | null;
}

/**
 * Admission first, then device availability. `admission` is null for a
 * profile that bypasses admission (it already shares the group with the
 * caller). A target's block of the caller maps to POLICY, exactly like a
 * NOBODY policy, so the block is never disclosed; BLOCKED means the caller
 * blocked the target and can unblock.
 */
export function decideE2eeEligibility({
  admission,
  activeDevices
}: {
  readonly admission: DirectMessageAdmission | null;
  readonly activeDevices: number;
}): E2eeEligibilityDecision {
  if (admission && !admission.allowed) {
    return {
      status:
        admission.reason === DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT
          ? E2eeEligibilityStatus.BLOCKED
          : E2eeEligibilityStatus.POLICY,
      reason: admission.reason
    };
  }
  return {
    status:
      activeDevices > 0
        ? E2eeEligibilityStatus.OK
        : E2eeEligibilityStatus.NO_DEVICES,
    reason: null
  };
}
