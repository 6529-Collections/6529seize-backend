import type {
  ReleaseCandidateStatus,
  ReleaseLane
} from '@/releaseBus/release-bus.types';

const TRANSITIONS: Readonly<
  Record<ReleaseCandidateStatus, readonly ReleaseCandidateStatus[]>
> = {
  DRAFT: ['READY_FOR_STAGING', 'CANCELLED', 'SUPERSEDED'],
  READY_FOR_STAGING: ['STAGING_CLAIMED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED'],
  STAGING_CLAIMED: [
    'STAGING_VALIDATING',
    'READY_FOR_STAGING',
    'QUARANTINED',
    'CANCELLED'
  ],
  STAGING_VALIDATING: ['STAGING_VALIDATED', 'STAGING_FAILED', 'QUARANTINED'],
  STAGING_VALIDATED: ['READY_FOR_PRODUCTION', 'SUPERSEDED', 'CANCELLED'],
  STAGING_FAILED: ['READY_FOR_STAGING', 'QUARANTINED', 'CANCELLED'],
  READY_FOR_PRODUCTION: [
    'PRODUCTION_CLAIMED',
    'BLOCKED',
    'SUPERSEDED',
    'CANCELLED'
  ],
  PRODUCTION_CLAIMED: [
    'PRODUCTION_VALIDATING',
    'READY_FOR_PRODUCTION',
    'QUARANTINED',
    'CANCELLED'
  ],
  PRODUCTION_VALIDATING: ['PRODUCTION_VALIDATED', 'QUARANTINED'],
  PRODUCTION_VALIDATED: [],
  BLOCKED: [
    'READY_FOR_STAGING',
    'READY_FOR_PRODUCTION',
    'SUPERSEDED',
    'CANCELLED'
  ],
  SUPERSEDED: [],
  QUARANTINED: ['READY_FOR_STAGING', 'CANCELLED'],
  CANCELLED: ['READY_FOR_STAGING', 'READY_FOR_PRODUCTION']
};

export function canTransitionCandidate(
  from: ReleaseCandidateStatus,
  to: ReleaseCandidateStatus
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertCandidateTransition(
  from: ReleaseCandidateStatus,
  to: ReleaseCandidateStatus
): void {
  if (!canTransitionCandidate(from, to)) {
    throw new Error(`Invalid release candidate transition: ${from} -> ${to}`);
  }
}

export function readyStatusForLane(lane: ReleaseLane): ReleaseCandidateStatus {
  return lane === 'STAGING' ? 'READY_FOR_STAGING' : 'READY_FOR_PRODUCTION';
}

export function claimedStatusForLane(
  lane: ReleaseLane
): ReleaseCandidateStatus {
  return lane === 'STAGING' ? 'STAGING_CLAIMED' : 'PRODUCTION_CLAIMED';
}

export function requiredDependencyStateForLane(
  lane: ReleaseLane
): 'STAGING_VALIDATED' | 'PRODUCTION_VALIDATED' {
  return lane === 'STAGING' ? 'STAGING_VALIDATED' : 'PRODUCTION_VALIDATED';
}
