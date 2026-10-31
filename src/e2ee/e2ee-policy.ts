import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';

// "Caller adds or claims target" policy (D109 contract v1, section 7.1).

export enum E2eeEligibilityStatus {
  OK = 'OK',
  POLICY = 'POLICY',
  BLOCKED = 'BLOCKED',
  NO_DEVICES = 'NO_DEVICES'
}

export interface E2eePolicyFacts {
  readonly profileId: string;
  readonly directMessagePolicy: ProfileDirectMessagePolicy;
  /** The target follows the caller (identity subscription target -> caller). */
  readonly followsCaller: boolean;
  /** A block exists in either direction between caller and target. */
  readonly blocked: boolean;
  readonly activeDevices: number;
}

/**
 * Blocks first, then the target's DM policy, then device availability.
 * `bypass` skips blocks and policy for a profile already sharing the group
 * with the caller; the caller's own profile always bypasses.
 */
export function decideE2eePolicy({
  callerProfileId,
  facts,
  bypass
}: {
  readonly callerProfileId: string;
  readonly facts: E2eePolicyFacts;
  readonly bypass: boolean;
}): E2eeEligibilityStatus {
  if (!bypass && facts.profileId !== callerProfileId) {
    if (facts.blocked) return E2eeEligibilityStatus.BLOCKED;
    if (facts.directMessagePolicy === ProfileDirectMessagePolicy.NOBODY) {
      return E2eeEligibilityStatus.POLICY;
    }
    if (
      facts.directMessagePolicy ===
        ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW &&
      !facts.followsCaller
    ) {
      return E2eeEligibilityStatus.POLICY;
    }
  }
  return facts.activeDevices > 0
    ? E2eeEligibilityStatus.OK
    : E2eeEligibilityStatus.NO_DEVICES;
}
