/** Source tracking is a separate deployment control from refresh processing and reads. */
export type MembershipSourceTrackingMode = 'inactive' | 'tracking-v1';

/**
 * Tracking requires an explicit staging deployment. An absent setting remains
 * inactive, including during mixed-version rollout. This gate never provisions
 * source evidence: a tracked write must use a provisioned source key or fail.
 */
export function resolveMembershipSourceTrackingMode(
  raw: string | undefined,
  stage: string | undefined = process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE
): MembershipSourceTrackingMode {
  if (raw === undefined || raw === 'inactive') return 'inactive';
  if (raw === 'tracking-v1' && stage === 'staging') return 'tracking-v1';
  throw new Error('Invalid membership source tracking deployment');
}

export function isMembershipSourceTrackingEnabled(
  raw: string | undefined,
  stage?: string
): boolean {
  return resolveMembershipSourceTrackingMode(raw, stage) === 'tracking-v1';
}
