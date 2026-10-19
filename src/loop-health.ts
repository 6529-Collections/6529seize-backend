/** Metadata-only business observations. Calls belong after persistence/verification,
 * never in a timer or a generic successful-handler hook. Times are Unix seconds. */
export interface LoopHealthObservation {
  operation:
    | 'indexing'
    | 'recalculation'
    | 'decisions'
    | 'native_execution'
    | 'publication'
    | 'processing';
  pending: boolean;
  progressAt?: number;
  oldestPendingAt?: number;
  watermarkAt?: number;
  deadlineAt?: number;
  nextDueAt?: number;
  recovery: 'automatic' | 'exhausted' | 'unavailable' | 'unknown';
}

let lastObservedAt = 0;
export function reportLoopHealth(observation: LoopHealthObservation): void {
  try {
    const service = process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (!service || !/^[\w-]{1,64}$/.test(service)) return;
    // Copy the finite contract; never serialize arbitrary caller properties.
    lastObservedAt = Math.max(Date.now() / 1000, lastObservedAt + 0.000001);
    const envelope: Record<string, unknown> = {
      _type: '6529.ops.loop-health.v1',
      service,
      operation: observation.operation,
      observedAt: lastObservedAt,
      pending: observation.pending,
      recovery: observation.recovery
    };
    for (const key of [
      'progressAt',
      'oldestPendingAt',
      'watermarkAt',
      'nextDueAt',
      'deadlineAt'
    ] as const) {
      const value = observation[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value <= 0) return;
      envelope[key] = value;
    }
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } catch {
    // Monitoring cannot change business execution or mask its original failure.
  }
}
