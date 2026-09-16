import type { MembershipRefreshTargetEntity } from '@/entities/IMembershipRefreshTarget';
import type { MembershipWorkerRun } from './membership-worker.types';

/** A published profile remains current until its next grant-time request is due. */
export function isMembershipFixturePublicationSettled(
  target: MembershipRefreshTargetEntity,
  run: MembershipWorkerRun,
  now: string
): boolean {
  if (
    target.active_run_id !== null ||
    run.status !== 'COMPLETED' ||
    run.scope !== 'PROFILE' ||
    run.target_id !== target.target_id ||
    run.request_version !== target.completed_version ||
    (run.valid_until_millis !== null &&
      BigInt(run.valid_until_millis) <= BigInt(now))
  )
    return false;
  if (target.requested_version === target.completed_version) return true;
  return (
    target.reason === 'grant-time-boundary' &&
    target.available_at_millis !== null &&
    run.valid_until_millis === target.available_at_millis &&
    BigInt(target.requested_version) ===
      BigInt(target.completed_version) + BigInt(1) &&
    BigInt(target.available_at_millis) > BigInt(now)
  );
}
