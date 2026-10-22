const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const LOOP_EVENT_TYPE = '6529.ops.loop-health.v1';
export interface LoopPolicy {
  service: string;
  intervalSeconds?: number;
  reservedConcurrency?: number;
  expectedOverlap: boolean;
  delaySeconds: number;
  stallSeconds: number;
  freshSeconds: number;
  operations: string[];
  optionalOperations?: string[];
  /** Event-driven workers can be idle indefinitely, but an old empty survey
   * cannot suppress new contention. Pending work never gets an idle exemption. */
  idleOperations?: string[];
  /** Some backlogs also shrink through terminal failures. Those workers must
   * supply successful persistence explicitly instead of counting removals. */
  oldestAdvanceIsProgress?: boolean;
  operationBudgets?: Record<
    string,
    | Partial<
        Pick<LoopPolicy, 'delaySeconds' | 'stallSeconds' | 'freshSeconds'>
      >
    | undefined
  >;
}
export interface LoopObservation {
  _type: typeof LOOP_EVENT_TYPE;
  service: string;
  operation: string;
  observedAt: number;
  progressAt?: number;
  oldestPendingAt?: number;
  watermarkAt?: number;
  deadlineAt?: number;
  nextDueAt?: number;
  pending: boolean;
  recovery: 'automatic' | 'exhausted' | 'unavailable' | 'unknown';
  /** Collector-owned observation baseline, not proof of business progress. */
  baselineAt?: number;
}
export type LoopReason =
  | 'overlap'
  | 'caught_up'
  | 'delayed'
  | 'stalled'
  | 'deadline'
  | 'recovery_failed'
  | 'unconfirmed'
  | 'telemetry_stale'
  | 'contention_cleared';
export interface LoopAssessment {
  expectedOverlap?: boolean;
  level: 'healthy' | 'amber' | 'red';
  reason: LoopReason;
  operation: string;
  scope: 'processing' | 'contention';
  ageSeconds?: number;
  recovery?: LoopObservation['recovery'];
}
export function parseLoopAssessment(
  input: unknown
): LoopAssessment | undefined {
  const v = record(input);
  const reasons: LoopReason[] = [
    'overlap',
    'caught_up',
    'delayed',
    'stalled',
    'deadline',
    'recovery_failed',
    'unconfirmed',
    'telemetry_stale',
    'contention_cleared'
  ];
  if (
    !['healthy', 'amber', 'red'].includes(String(v.level)) ||
    !reasons.includes(v.reason as LoopReason) ||
    !['processing', 'contention'].includes(String(v.scope)) ||
    typeof v.operation !== 'string' ||
    !/^[a-z_]{1,40}$/.test(v.operation)
  )
    return undefined;
  return {
    level: v.level as LoopAssessment['level'],
    reason: v.reason as LoopReason,
    ...(typeof v.expectedOverlap === 'boolean'
      ? { expectedOverlap: v.expectedOverlap }
      : {}),
    operation: v.operation,
    scope: v.scope as LoopAssessment['scope'],
    ...(['automatic', 'exhausted', 'unavailable', 'unknown'].includes(
      String(v.recovery)
    )
      ? { recovery: v.recovery as LoopObservation['recovery'] }
      : {}),
    ...(typeof v.ageSeconds === 'number' &&
    Number.isFinite(v.ageSeconds) &&
    v.ageSeconds >= 0
      ? { ageSeconds: Math.floor(v.ageSeconds) }
      : {})
  };
}
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function parseLoopObservation(input: unknown): LoopObservation {
  const v = record(input);
  if (
    v._type !== LOOP_EVENT_TYPE ||
    typeof v.service !== 'string' ||
    !/^[\w-]{1,64}$/.test(v.service) ||
    typeof v.operation !== 'string' ||
    !/^[a-z_]{1,40}$/.test(v.operation) ||
    !timestamp(v.observedAt) ||
    typeof v.pending !== 'boolean' ||
    !['automatic', 'exhausted', 'unavailable', 'unknown'].includes(
      String(v.recovery)
    )
  )
    throw new Error('INVALID_LOOP_OBSERVATION');
  const result: LoopObservation = {
    _type: LOOP_EVENT_TYPE,
    service: v.service,
    operation: v.operation,
    observedAt: v.observedAt,
    pending: v.pending,
    recovery: v.recovery as LoopObservation['recovery']
  };
  for (const key of [
    'progressAt',
    'oldestPendingAt',
    'watermarkAt',
    'nextDueAt',
    'deadlineAt'
  ] as const) {
    if (v[key] === undefined) continue;
    if (
      !timestamp(v[key]) ||
      (!['deadlineAt', 'nextDueAt'].includes(key) && v[key] > v.observedAt)
    )
      throw new Error('INVALID_LOOP_TIMESTAMP');
    result[key] = v[key];
  }
  return result;
}

function assessOperation(
  policy: LoopPolicy,
  observation: LoopObservation,
  now: number,
  throttleActive: boolean
): LoopAssessment {
  policy = { ...policy, ...policy.operationBudgets?.[observation.operation] };
  if (
    observation.nextDueAt !== undefined &&
    now >= observation.nextDueAt &&
    !observation.pending
  ) {
    observation = {
      ...observation,
      pending: true,
      oldestPendingAt: observation.nextDueAt,
      progressAt: undefined,
      baselineAt: observation.nextDueAt
    };
  }
  const base = {
    operation: observation.operation,
    scope: 'processing' as const,
    recovery: observation.recovery
  };
  const age = Math.max(
    0,
    now - (observation.oldestPendingAt ?? observation.watermarkAt ?? now)
  );
  const progressAge =
    now -
    (observation.progressAt ??
      observation.baselineAt ??
      observation.observedAt);
  if (
    !observation.pending &&
    policy.optionalOperations?.includes(observation.operation)
  )
    return { ...base, level: 'healthy', reason: 'caught_up' };
  if (
    !observation.pending &&
    !throttleActive &&
    policy.idleOperations?.includes(observation.operation)
  )
    return { ...base, level: 'healthy', reason: 'caught_up' };
  const behind =
    observation.pending ||
    (observation.watermarkAt !== undefined && age > policy.delaySeconds);
  const failure = criticalReason(
    observation,
    now,
    progressAge,
    policy.stallSeconds,
    behind
  );
  if (failure)
    return {
      ...base,
      level: 'red',
      reason: failure,
      ageSeconds: failure === 'stalled' ? progressAge : age
    };
  const stale = now - observation.observedAt > policy.freshSeconds;
  if (stale) return { ...base, level: 'amber', reason: 'telemetry_stale' };
  if (behind && age > policy.delaySeconds)
    return { ...base, level: 'amber', reason: 'delayed', ageSeconds: age };
  if (observation.pending && observation.recovery !== 'automatic')
    return { ...base, level: 'amber', reason: 'unconfirmed', ageSeconds: age };
  return {
    ...base,
    level: 'healthy',
    reason: observation.pending ? 'overlap' : 'caught_up'
  };
}

function criticalReason(
  observation: LoopObservation,
  now: number,
  progressAge: number,
  stallSeconds: number,
  behind: boolean
): LoopReason | undefined {
  if (
    observation.pending &&
    observation.deadlineAt !== undefined &&
    observation.deadlineAt - now <= 60
  )
    return 'deadline';
  if (
    observation.pending &&
    ['exhausted', 'unavailable'].includes(observation.recovery)
  )
    return 'recovery_failed';
  if (behind && progressAge > stallSeconds) return 'stalled';
  return undefined;
}

export function assessLoop(
  policy: LoopPolicy,
  observations: LoopObservation[],
  throttleActive: boolean,
  now: number,
  processingIncident = false
): LoopAssessment {
  const assessments = policy.operations.map((operation): LoopAssessment => {
    const observation = observations.find(
      (item) => item.operation === operation
    );
    if (observation)
      return assessOperation(policy, observation, now, throttleActive);
    if (policy.optionalOperations?.includes(operation))
      return {
        level: 'healthy',
        reason: 'caught_up',
        operation,
        scope: 'processing'
      };
    return {
      level: throttleActive || processingIncident ? 'amber' : 'healthy',
      reason:
        throttleActive || processingIncident
          ? 'unconfirmed'
          : 'contention_cleared',
      operation,
      scope: processingIncident ? 'processing' : 'contention'
    };
  });
  const rank = { healthy: 0, amber: 1, red: 2 };
  const idle: LoopAssessment = {
    level: 'healthy',
    reason: 'contention_cleared',
    operation: 'processing',
    scope: 'contention'
  };
  return assessments.reduce(
    (worst, current) =>
      rank[current.level] > rank[worst.level] ? current : worst,
    assessments[0] ?? idle
  );
}
