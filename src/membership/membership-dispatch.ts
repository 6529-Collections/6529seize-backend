import { performance } from 'node:perf_hooks';
import { RequestContext } from '@/request.context';
import { SqlExecutionBudget, SqlExecutor } from '@/sql-executor';
import { withMembershipPrimaryTransaction } from './membership-primary';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipDispatchDb } from './membership-dispatch.db';
import { normalizeRefreshTarget } from './membership-validation';
import {
  isMembershipDispatchLockBusy,
  validateMembershipDispatchOptions
} from './membership-dispatch-validation';
import {
  MembershipDispatchHeldTargetGuard,
  MembershipDispatchHint,
  MembershipDispatchLane,
  MembershipDispatchOptions,
  MembershipDispatchPosition,
  MembershipDispatchRawKey,
  MembershipDispatchReservation,
  MembershipDispatchResult,
  MembershipDispatchSender
} from './membership-dispatch.types';

function transactionBudget(
  options: MembershipDispatchOptions,
  duration: number
): SqlExecutionBudget {
  return {
    deadlineMonotonicMillis: performance.now() + duration,
    maxStatementMillis: options.max_statement_millis,
    finalizationReserveMillis: options.finalization_reserve_millis,
    lockWaitSeconds: options.lock_wait_seconds
  };
}
function isIntegrity(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'INTEGRITY'
  );
}

function isUnknownCommit(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'commitOutcome' in error &&
    error.commitOutcome === 'UNKNOWN'
  );
}

function alreadyVisited(
  raw: MembershipDispatchRawKey,
  visited: Set<string>
): boolean {
  let identity: string;
  try {
    const target = normalizeRefreshTarget(raw);
    identity = `${target.scope}/${target.target_id}`;
  } catch {
    // The point repository retains the existing invalid-target classification.
    return false;
  }
  if (visited.has(identity)) return true;
  visited.add(identity);
  return false;
}

/** External recovery only. A hint is scheduling data, never membership authority. */
export class MembershipRefreshDispatcher {
  private readonly checkpoints: MembershipDispatchCheckpointsDb;
  private readonly candidates: MembershipDispatchDb;
  constructor(
    private readonly db: SqlExecutor,
    private readonly sender: MembershipDispatchSender,
    private readonly heldTargetGuard?: MembershipDispatchHeldTargetGuard
  ) {
    this.checkpoints = new MembershipDispatchCheckpointsDb(() => db);
    this.candidates = new MembershipDispatchDb(() => db);
  }

  async run(
    options: MembershipDispatchOptions,
    context: RequestContext = {}
  ): Promise<MembershipDispatchResult> {
    validateMembershipDispatchOptions(options);
    const deadline = Math.min(
      options.deadline_monotonic_millis,
      performance.now() + 20000
    );
    const result: MembershipDispatchResult = {
      raw_candidates: 0,
      due_candidates: 0,
      target_pk_candidates: 0,
      sent: 0,
      skipped: 0,
      send_failed: 0,
      control_busy: false,
      budget_exhausted: false,
      oldest_due_age_millis: 0,
      parked_seen: 0,
      outcomes: {}
    };
    const closed = new Set<MembershipDispatchLane>();
    // At most max_candidates entries; a new invocation gets a fresh set.
    const visited = new Set<string>();
    const attempts: Record<MembershipDispatchLane, number> = {
      DUE: 0,
      TARGET_PK: 0
    };
    for (
      let attempt = 0;
      attempt < options.max_candidates && closed.size < 2;
      attempt++
    ) {
      // Reserve the complete healthy candidate quantum before durably advancing.
      const required =
        options.control_millis +
        options.target_millis +
        options.send_millis +
        options.cleanup_reserve_millis;
      if (performance.now() + required >= deadline) {
        result.budget_exhausted = true;
        break;
      }
      const position = await this.position(
        options,
        Array.from(closed),
        context,
        result
      );
      if (!position) break;
      attempts[position.lane]++;
      if (position.exhausted || attempts[position.lane] >= options.max_per_lane)
        closed.add(position.lane);
      if (!position.key) {
        this.count(result, 'EMPTY');
        continue;
      }
      this.countCandidate(position.lane, result);
      // The durable raw frontier already advanced. Reserve each canonical target
      // once even when a worker checkpoints before the other lane reaches it.
      if (alreadyVisited(position.key, visited)) {
        result.skipped++;
        this.count(result, 'DUPLICATE_TARGET');
        continue;
      }
      if (
        !(await this.dispatchPosition(
          position,
          options,
          deadline,
          context,
          result
        ))
      )
        break;
    }
    return result;
  }

  private countCandidate(
    lane: MembershipDispatchLane,
    result: MembershipDispatchResult
  ): void {
    result.raw_candidates++;
    if (lane === 'DUE') result.due_candidates++;
    else result.target_pk_candidates++;
  }

  private hasTime(
    duration: number,
    deadline: number,
    result: MembershipDispatchResult
  ): boolean {
    if (performance.now() + duration < deadline) return true;
    result.budget_exhausted = true;
    return false;
  }

  private async dispatchPosition(
    position: MembershipDispatchPosition,
    options: MembershipDispatchOptions,
    deadline: number,
    context: RequestContext,
    result: MembershipDispatchResult
  ): Promise<boolean> {
    const sendAllowance = options.send_millis + options.cleanup_reserve_millis;
    if (!this.hasTime(options.target_millis + sendAllowance, deadline, result))
      return false;
    const reservation = await this.reserve(position, options, context);
    result.oldest_due_age_millis = Math.max(
      result.oldest_due_age_millis,
      reservation.observed_due_age_millis
    );
    if (reservation.outcome !== 'RESERVED') {
      result.skipped++;
      if (reservation.outcome === 'PARKED') result.parked_seen++;
      this.count(result, reservation.outcome);
      return true;
    }
    if (!this.hasTime(sendAllowance, deadline, result)) return false;
    if (
      await this.send(reservation.hint, performance.now() + options.send_millis)
    ) {
      result.sent++;
      this.count(result, 'SENT');
    } else {
      result.send_failed++;
      this.count(result, 'SEND_FAILED');
    }
    return true;
  }

  private count(
    result: MembershipDispatchResult,
    outcome: keyof MembershipDispatchResult['outcomes']
  ): void {
    result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
  }

  private async position(
    options: MembershipDispatchOptions,
    closed: MembershipDispatchLane[],
    context: RequestContext,
    result: MembershipDispatchResult
  ): Promise<MembershipDispatchPosition | null> {
    try {
      return await withMembershipPrimaryTransaction(
        this.db,
        (ctx) => this.checkpoints.reserve(closed, ctx),
        context,
        transactionBudget(options, options.control_millis)
      );
    } catch (error) {
      if (isUnknownCommit(error)) throw error;
      if (!isMembershipDispatchLockBusy(error)) throw error;
      result.control_busy = true;
      return null;
    }
  }

  private async reserve(
    position: MembershipDispatchPosition,
    options: MembershipDispatchOptions,
    context: RequestContext
  ): Promise<MembershipDispatchReservation> {
    try {
      return await withMembershipPrimaryTransaction(
        this.db,
        (ctx) =>
          this.candidates.reserve(
            position.key!,
            options.reservation_millis,
            this.heldTargetGuard,
            ctx
          ),
        context,
        transactionBudget(options, options.target_millis)
      );
    } catch (error) {
      if (isUnknownCommit(error)) throw error;
      if (isMembershipDispatchLockBusy(error))
        return { outcome: 'LOCK_BUSY', observed_due_age_millis: 0 };
      if (isIntegrity(error))
        return { outcome: 'INTEGRITY', observed_due_age_millis: 0 };
      // Includes UNKNOWN commit: never send or repair uncertain reservations.
      throw error;
    }
  }

  private async send(
    hint: MembershipDispatchHint,
    deadline: number
  ): Promise<boolean> {
    const controller = new AbortController();
    // Only network delivery is settled here; SQL always uses physical connection
    // revocation. A timed-out send is ambiguous and retains its DB reservation.
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => {
          controller.abort();
          resolve(false);
        },
        Math.max(0, deadline - performance.now())
      );
      const finish = (sent: boolean) => {
        clearTimeout(timer);
        resolve(sent && performance.now() < deadline);
      };
      Promise.resolve()
        .then(() =>
          this.sender(hint, {
            deadline_monotonic_millis: deadline,
            signal: controller.signal
          })
        )
        .then(
          () => finish(true),
          () => finish(false)
        );
    });
  }
}
