/**
 * The deadline for one Redis call, aware of Lambda freezes and event-loop
 * stalls.
 *
 * Lambda freezes a container between invocations while wall-clock time goes
 * on. A command started at the end of one invocation (the request cache
 * writes after the response) finds its timer expired when the container
 * thaws, and Node runs expired timers before it reads sockets. A plain
 * Promise.race then reports a timeout even though the reply is already
 * there. The same happens to any command whose timer fires late because the
 * event loop was busy.
 *
 * So a deadline:
 * - settles one event-loop turn after its timer fires (setImmediate runs
 *   after the poll phase), so a reply that is already readable wins;
 * - treats a timer that fires more than LATE_TIMER_MS after its deadline as
 *   late: the process was suspended or stalled, and Redis was not measured.
 *   The command gets a short grace (LATE_TIMER_GRACE_MS) instead of
 *   failing at once;
 * - reports what happened: `slow` (Redis really missed the deadline),
 *   `suspended_recovered` (late timer, reply arrived), or
 *   `suspended_timeout` (late timer, then no reply within the grace).
 *
 * A missed deadline leaves the command's outcome unknown (it may still reach
 * Redis), exactly as before: callers must never treat it as success.
 */
export const LATE_TIMER_MS = 250;

/**
 * How long a command still gets after a late timer. Packets that reached a
 * frozen VM are delivered within milliseconds of the thaw, so 100 ms catches
 * them. It is deliberately not a fresh full budget: on an awaited call whose
 * event loop stalled while Redis is also slow, that would add up to another
 * budget (500 ms on the api) to the request.
 */
export const LATE_TIMER_GRACE_MS = 100;

export type DeadlineMiss = 'slow' | 'suspended_timeout';
export type DeadlineOutcome = DeadlineMiss | 'suspended_recovered';

export interface DeadlineEvent {
  readonly operation: string;
  readonly outcome: DeadlineOutcome;
  /** How late the late timer fired; 0 for `slow`. */
  readonly overdueMs: number;
}

export interface DeadlineOptions {
  readonly operation: string;
  readonly timeoutMs: number;
  /** The error a missed deadline rejects with. */
  readonly timeoutError: (miss: DeadlineMiss, overdueMs: number) => Error;
  /** Receives every deadline event; defaults to an EMF count. */
  readonly report?: (event: DeadlineEvent) => void;
  readonly now?: () => number;
}

export function withRedisDeadline<T>(
  work: Promise<T>,
  options: DeadlineOptions
): Promise<T> {
  const now = options.now ?? Date.now;
  const report = options.report ?? recordDeadlineEvent;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let immediate: ReturnType<typeof setImmediate> | undefined;
    let lateByMs: number | null = null;
    const settle = (action: () => void): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (immediate !== undefined) clearImmediate(immediate);
      action();
      return true;
    };
    const arm = (ms: number) => {
      const deadline = now() + ms;
      timer = setTimeout(() => {
        const overdueMs = Math.max(0, now() - deadline);
        if (lateByMs === null && overdueMs > LATE_TIMER_MS) {
          // Suspended or stalled: Redis did not get its budget. A short
          // grace lets a reply delivered just after the thaw arrive.
          lateByMs = overdueMs;
          arm(Math.min(LATE_TIMER_GRACE_MS, options.timeoutMs));
          return;
        }
        // A reply already readable is handled in the poll phase, before this.
        immediate = setImmediate(() => {
          const miss: DeadlineMiss =
            lateByMs === null ? 'slow' : 'suspended_timeout';
          const late = lateByMs ?? 0;
          if (settle(() => reject(options.timeoutError(miss, late))))
            safeReport(report, {
              operation: options.operation,
              outcome: miss,
              overdueMs: late
            });
        });
      }, ms);
    };
    arm(options.timeoutMs);
    work.then(
      (value) => {
        if (settle(() => resolve(value)) && lateByMs !== null)
          safeReport(report, {
            operation: options.operation,
            outcome: 'suspended_recovered',
            overdueMs: lateByMs
          });
      },
      (error: unknown) => {
        settle(() => reject(error));
      }
    );
  });
}

function safeReport(
  report: (event: DeadlineEvent) => void,
  event: DeadlineEvent
): void {
  try {
    report(event);
  } catch {
    /* Telemetry must not change a command's outcome. */
  }
}

function environment(): 'staging' | 'prod' | 'unknown' {
  if ((process.env.SENTRY_ENVIRONMENT ?? '').includes('staging'))
    return 'staging';
  return process.env.AWS_REGION === 'us-east-1' ? 'prod' : 'unknown';
}

/**
 * One EMF count per deadline event in `6529/Redis`, by Outcome, so genuine
 * slowness (`slow`) stays visible apart from late timers whatever the log
 * rate limits drop. The operation is a property, not a dimension.
 */
export function recordDeadlineEvent(event: DeadlineEvent): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const late = event.outcome !== 'slow';
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/Redis',
              Dimensions: [['Environment', 'Outcome']],
              Metrics: [
                { Name: 'DeadlineEvents', Unit: 'Count' },
                ...(late ? [{ Name: 'TimerLateMs', Unit: 'Milliseconds' }] : [])
              ]
            }
          ]
        },
        Environment: environment(),
        Outcome: event.outcome,
        Operation: event.operation,
        DeadlineEvents: 1,
        ...(late ? { TimerLateMs: event.overdueMs } : {})
      })}\n`
    );
  } catch {
    /* Telemetry must not change a command's outcome. */
  }
}
