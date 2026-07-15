import {
  assertCandidateTransition,
  canTransitionCandidate
} from '@/releaseBus/release-bus.state-machine';

describe('release candidate state machine', () => {
  it('requires exact staging validation before production readiness', () => {
    expect(
      canTransitionCandidate('STAGING_VALIDATED', 'READY_FOR_PRODUCTION')
    ).toBe(true);
    expect(
      canTransitionCandidate('READY_FOR_STAGING', 'READY_FOR_PRODUCTION')
    ).toBe(false);
  });

  it('does not permit cancellation after production validation begins', () => {
    expect(canTransitionCandidate('PRODUCTION_CLAIMED', 'CANCELLED')).toBe(
      true
    );
    expect(() =>
      assertCandidateTransition('PRODUCTION_VALIDATING', 'CANCELLED')
    ).toThrow('Invalid release candidate transition');
  });

  it('allows an explicitly cancelled immutable SHA to be submitted again', () => {
    expect(canTransitionCandidate('CANCELLED', 'READY_FOR_STAGING')).toBe(true);
    expect(canTransitionCandidate('CANCELLED', 'READY_FOR_PRODUCTION')).toBe(
      true
    );
  });
});
