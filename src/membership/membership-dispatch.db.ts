import { MEMBERSHIP_REFRESH_TARGETS_TABLE } from '@/constants';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { timeMembershipOperation } from './membership-repository.utils';
import {
  assertMembershipBoundedInteger,
  normalizeCounter,
  normalizeRefreshTarget
} from './membership-validation';
import {
  membershipAddCounter,
  membershipUuidSchema
} from './membership-worker-validation';
import { MembershipWorkerDb } from './membership-worker.db';
import { MEMBERSHIP_EVALUATOR_SPEC_VERSION } from './membership-profile-evaluator';
import {
  MembershipDispatchHeldTargetGuard,
  MembershipDispatchRawKey,
  MembershipDispatchReservation,
  MembershipDispatchSkip
} from './membership-dispatch.types';

interface Target extends MembershipDispatchRawKey {
  requested_version: string;
  completed_version: string;
  available_at_millis: string | null;
  active_run_id: string | null;
  attempts: number;
}

function validTarget(row: Target, key: MembershipDispatchRawKey): boolean {
  try {
    if (row.scope !== key.scope || row.target_id !== key.target_id)
      return false;
    normalizeCounter(row.requested_version);
    normalizeCounter(row.completed_version);
    if (BigInt(row.completed_version) > BigInt(row.requested_version))
      return false;
    if (row.available_at_millis !== null)
      normalizeCounter(row.available_at_millis);
    if (row.active_run_id !== null)
      membershipUuidSchema.parse(row.active_run_id);
    assertMembershipBoundedInteger(
      row.attempts,
      'dispatch target attempts',
      0,
      2147483647
    );
    return true;
  } catch {
    return false;
  }
}

/** Exact target -> optional active run -> closed fixture guard; no control-row lock. */
export class MembershipDispatchDb extends LazyDbAccessCompatibleService {
  async reserve(
    raw: MembershipDispatchRawKey,
    reservationMillis: number,
    heldTargetGuard: MembershipDispatchHeldTargetGuard | undefined,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipDispatchReservation> {
    return timeMembershipOperation(
      'MembershipDispatchDb->reserve',
      ctx,
      async () => {
        assertMembershipBoundedInteger(
          reservationMillis,
          'delivery reservation',
          1000,
          120000
        );
        let key;
        try {
          key = normalizeRefreshTarget(raw);
        } catch {
          return { outcome: 'INVALID_TARGET', observed_due_age_millis: 0 };
        }
        const target = await this.db.oneOrNull<Target>(
          `SELECT scope,target_id,CAST(requested_version AS CHAR) requested_version,
        CAST(completed_version AS CHAR) completed_version,CAST(available_at_millis AS CHAR) available_at_millis,active_run_id,attempts
        FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} WHERE scope=:scope AND target_id=:target_id FOR UPDATE NOWAIT`,
          key,
          membershipQueryOptions(ctx)
        );
        if (!target) return { outcome: 'MISSING', observed_due_age_millis: 0 };
        if (!validTarget(target, key))
          return { outcome: 'INTEGRITY', observed_due_age_millis: 0 };
        if (target.requested_version === target.completed_version)
          return { outcome: 'SETTLED', observed_due_age_millis: 0 };
        if (target.available_at_millis === null)
          return { outcome: 'PARKED', observed_due_age_millis: 0 };
        const worker = new MembershipWorkerDb(() => this.db);
        const now = await worker.now(ctx);
        if (BigInt(target.available_at_millis) > BigInt(now))
          return { outcome: 'FUTURE', observed_due_age_millis: 0 };
        const age = BigInt(now) - BigInt(target.available_at_millis);
        const observed_due_age_millis = Number(
          age > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : age
        );
        const runOutcome = await this.runDisposition(target, now, worker, ctx);
        if (runOutcome) return { outcome: runOutcome, observed_due_age_millis };
        if (heldTargetGuard && (await heldTargetGuard(key, ctx)))
          return { outcome: 'FIXTURE_HELD', observed_due_age_millis };
        // A closed fixture guard can wait briefly. Start suppression from a
        // fresh DB timestamp immediately before the scheduling write.
        const reservationNow = await worker.now(ctx);
        const reservedUntil = membershipAddCounter(
          reservationNow,
          reservationMillis
        );
        const result = await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=:reservedUntil,updated_at_millis=:now
        WHERE scope=:scope AND target_id=:target_id`,
          { ...key, reservedUntil, now: reservationNow },
          membershipQueryOptions(ctx)
        );
        if (this.db.getAffectedRows(result) !== 1)
          throw new Error('Locked dispatch target disappeared');
        return {
          outcome: 'RESERVED',
          observed_due_age_millis,
          hint: {
            target: key,
            delivery: {
              requested_version: target.requested_version,
              reserved_until_millis: reservedUntil
            }
          }
        };
      }
    );
  }

  private async runDisposition(
    target: Target,
    now: string,
    worker: MembershipWorkerDb,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipDispatchSkip | null> {
    if (target.active_run_id === null) return null;
    const run = await worker.run(target.active_run_id, true, ctx);
    if (
      !run ||
      run.id !== target.active_run_id ||
      run.scope !== target.scope ||
      run.target_id !== target.target_id ||
      !['PENDING', 'RUNNING'].includes(run.status) ||
      run.spec_version !== MEMBERSHIP_EVALUATOR_SPEC_VERSION ||
      run.progress_cursor.phase === 'DONE' ||
      run.completed_at_millis !== null ||
      BigInt(run.request_version) > BigInt(target.requested_version) ||
      BigInt(run.request_version) <= BigInt(target.completed_version)
    )
      return 'INTEGRITY';
    if (
      run.lease_expires_at_millis !== null &&
      BigInt(run.lease_expires_at_millis) > BigInt(now)
    )
      return 'LIVE_LEASE';
    return null;
  }
}
