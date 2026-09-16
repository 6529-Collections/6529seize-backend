import { performance } from 'node:perf_hooks';
import { MembershipDispatchOptions } from './membership-dispatch.types';

export function membershipDispatchTestOptions(
  overrides: Partial<MembershipDispatchOptions> = {}
): MembershipDispatchOptions {
  return {
    deadline_monotonic_millis: performance.now() + 20000,
    control_millis: 2000,
    target_millis: 2000,
    send_millis: 1000,
    cleanup_reserve_millis: 500,
    max_statement_millis: 1000,
    finalization_reserve_millis: 200,
    lock_wait_seconds: 1,
    reservation_millis: 1000,
    max_candidates: 40,
    max_per_lane: 20,
    ...overrides
  };
}
