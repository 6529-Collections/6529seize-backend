/** Source tracking is a separate deployment control from refresh processing and reads. */
export type MembershipSourceTrackingMode = 'inactive' | 'tracking-v1';

/**
 * Tracking requires an explicit staging deployment. An absent setting remains
 * inactive, including during mixed-version rollout. This gate never provisions
 * source evidence: a tracked write must use a provisioned source key or fail.
 */
export function resolveMembershipSourceTrackingMode(
  raw: string | undefined,
  stage: string | undefined
): MembershipSourceTrackingMode {
  if (raw === undefined || raw === 'inactive') return 'inactive';
  if (raw === 'tracking-v1' && stage === 'staging') return 'tracking-v1';
  throw new Error('Invalid membership source tracking deployment');
}

export function isMembershipSourceTrackingEnabled(
  raw: string | undefined,
  stage: string | undefined
): boolean {
  return resolveMembershipSourceTrackingMode(raw, stage) === 'tracking-v1';
}

/** Captured at module evaluation, before shared secrets can alter process.env. */
export const membershipSourceTrackingDeployment = Object.freeze({
  mode: resolveMembershipSourceTrackingMode(
    process.env.MEMBERSHIP_SOURCE_TRACKING_MODE,
    process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE
  ),
  stage: process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE ?? null
});

export function isMembershipSourceTrackingActive(): boolean {
  return membershipSourceTrackingDeployment.mode === 'tracking-v1';
}
