import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, setting, read, put, enqueue } from './aws.js';
import { Alert, Environment, EVENT_TYPE, hash, record } from './contract.js';
import LOOP_POLICIES from './loop-policies.generated.json' with { type: 'json' };
import {
  assessLoop,
  LoopAssessment,
  LoopObservation,
  LoopPolicy,
  parseLoopObservation
} from './loop-health.js';

export const policiesFor = (env: Environment): LoopPolicy[] =>
  LOOP_POLICIES[env];
const observationKey = (service: string, operation: string) =>
  `loop:observation:${service}:${operation}`;

/** Log delivery and alarm transitions can arrive late or more than once. */
async function latest(
  pk: string,
  observedAt: number,
  value: Record<string, unknown>,
  expectedAt?: number | null
): Promise<boolean> {
  const retain =
    value.active === true ||
    value.pending === true ||
    typeof value.nextDueAt === 'number';
  let expectedGuard = '';
  if (expectedAt === null)
    expectedGuard = ' AND attribute_not_exists(observedAt)';
  else if (expectedAt !== undefined)
    expectedGuard = ' AND observedAt = :expected';
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: setting('RECEIPTS_TABLE'),
        Key: { pk },
        UpdateExpression:
          'SET observedAt = :at, payload = :payload' +
          (retain ? ' REMOVE expiresAt' : ', expiresAt = :expiry'),
        ConditionExpression:
          '(attribute_not_exists(observedAt) OR observedAt < :at)' +
          expectedGuard,
        ExpressionAttributeValues: {
          ':at': observedAt,
          ':payload': value,
          ...(typeof expectedAt === 'number'
            ? { ':expected': expectedAt }
            : {}),
          ...(!retain
            ? { ':expiry': Math.floor(Date.now() / 1000) + 45 * 86400 }
            : {})
        }
      })
    );
    return true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== 'ConditionalCheckFailedException'
    )
      throw error;
    return false;
  }
}

function saveIncident(
  key: string,
  values: Record<string, unknown>,
  abortSignal?: AbortSignal
): Promise<void> {
  // Active conditions and pending sends must survive the ordinary receipt TTL.
  return put(
    key,
    {
      ...values,
      expiresAt:
        values.open === true
          ? undefined
          : Math.floor(Date.now() / 1000) + 45 * 86400
    },
    abortSignal
  );
}

function continuedObservation(
  observation: LoopObservation,
  previous: Record<string, unknown>
): Record<string, unknown> {
  // A late scheduled start is still the same overdue work. Starting a retry
  // cannot clear its incident or restart its stall/delay clock.
  const overdueAt =
    previous.pending === false &&
    typeof previous.nextDueAt === 'number' &&
    previous.nextDueAt <= observation.observedAt &&
    observation.pending
      ? previous.nextDueAt
      : undefined;
  const continuing =
    observation.pending &&
    (previous.pending === true || overdueAt !== undefined);
  const baselineAt =
    overdueAt ??
    (continuing && typeof previous.baselineAt === 'number'
      ? previous.baselineAt
      : observation.observedAt);
  const priorProgress =
    continuing &&
    overdueAt === undefined &&
    typeof previous.progressAt === 'number'
      ? previous.progressAt
      : 0;
  const oldestAdvanced =
    continuing &&
    typeof previous.oldestPendingAt === 'number' &&
    observation.oldestPendingAt !== undefined &&
    observation.oldestPendingAt > previous.oldestPendingAt;
  return {
    ...observation,
    ...(continuing && observation.oldestPendingAt === undefined
      ? { oldestPendingAt: overdueAt ?? previous.oldestPendingAt }
      : {}),
    baselineAt,
    progressAt:
      Math.max(
        priorProgress,
        observation.progressAt ?? 0,
        oldestAdvanced ? observation.observedAt : 0
      ) || undefined
  };
}

export async function receiveLoopObservation(
  input: unknown,
  env: Environment
): Promise<void> {
  const observation = parseLoopObservation(input);
  const policy = policiesFor(env).find(
    (item) => item.service === observation.service
  );
  if (!policy?.operations.includes(observation.operation))
    throw new Error('UNAPPROVED_LOOP_OPERATION');
  if (observation.observedAt > Date.now() / 1000 + 5)
    throw new Error('FUTURE_LOOP_OBSERVATION');
  const key = observationKey(observation.service, observation.operation);
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await read(key);
    if (
      typeof saved?.observedAt === 'number' &&
      saved.observedAt >= observation.observedAt
    )
      return;
    const accepted = await latest(
      key,
      observation.observedAt,
      continuedObservation(observation, record(saved?.payload)),
      typeof saved?.observedAt === 'number' ? saved.observedAt : null
    );
    if (accepted) return;
  }
  throw new Error('LOOP_OBSERVATION_CONFLICT');
}

function pruneResolvedAlarms(alarms: Record<string, unknown>): void {
  const inactive = Object.keys(alarms)
    .filter((key) => record(alarms[key]).active !== true)
    .sort(
      (a, b) => Number(record(alarms[a]).at) - Number(record(alarms[b]).at)
    );
  // Retain recent OK tombstones to reject late ALARM transitions, reclaiming only
  // resolved entries on renames. Active alarms are never evicted to make room.
  while (Object.keys(alarms).length > 8 && inactive.length)
    delete alarms[inactive.shift()!];
  if (Object.keys(alarms).length > 8)
    throw new Error('LOOP_ALARM_INVENTORY_OVERFLOW');
}

export async function receiveLoopThrottle(
  service: string,
  active: boolean,
  at: number,
  identity = 'generated'
): Promise<void> {
  if (!Number.isFinite(at) || at > Date.now() / 1000 + 5)
    throw new Error('INVALID_LOOP_ALARM_TIME');
  const key = `loop:throttle:${service}`;
  const alarmKey = hash(identity);
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await read(key);
    const alarms = { ...record(record(saved?.payload).alarms) };
    if (
      typeof record(alarms[alarmKey]).at === 'number' &&
      Number(record(alarms[alarmKey]).at) >= at
    )
      return;
    alarms[alarmKey] = { active, at };
    pruneResolvedAlarms(alarms);
    // This is a collector revision, independent of the source transition timestamp.
    const revision = Math.max(Date.now(), Number(saved?.observedAt ?? 0) + 1);
    const accepted = await latest(
      key,
      revision,
      {
        active: Object.values(alarms).some(
          (value) => record(value).active === true
        ),
        alarms
      },
      typeof saved?.observedAt === 'number' ? saved.observedAt : null
    );
    if (accepted) return;
  }
  throw new Error('LOOP_THROTTLE_CONFLICT');
}

function loopAlert(
  env: Environment,
  service: string,
  assessment: LoopAssessment,
  now: number,
  recovery: boolean
): Alert {
  const identity = `${env}:${service}:${now}:${assessment.level}:${assessment.reason}:${assessment.operation}:${assessment.recovery ?? 'unknown'}:${assessment.scope}`;
  let severity: Alert['severity'] = 'warning';
  if (recovery) severity = 'recovery';
  else if (assessment.level === 'red') severity = 'critical';
  return {
    _type: EVENT_TYPE,
    eventId: `loop:${hash(identity)}`,
    occurredAt: new Date(now * 1000).toISOString(),
    environment: env,
    service,
    severity,
    code: recovery ? 'LOOP_RECOVERY' : 'LOOP_HEALTH',
    fingerprint: hash(`loop:${env}:${service}`),
    loop: { ...assessment }
  };
}

export async function monitorLoop(
  policy: LoopPolicy,
  env: Environment,
  now: number,
  abortSignal?: AbortSignal
): Promise<void> {
  abortSignal?.throwIfAborted();
  const key = `loop:incident:${policy.service}`;
  const [saved, throttle, ...rows] = await Promise.all([
    read(key, abortSignal),
    read(`loop:throttle:${policy.service}`, abortSignal),
    ...policy.operations.map((op) =>
      read(observationKey(policy.service, op), abortSignal)
    )
  ]);
  // Persist the next notification before enqueue. A timeout/retry reuses its exact event ID.
  // This handler's existing reserved concurrency is one: it is the sole incident writer.
  const previous = { ...saved };
  if (previous.pendingAlert) {
    await enqueue(
      { kind: 'alert', alert: previous.pendingAlert as Alert },
      true,
      0,
      abortSignal
    );
    delete previous.pendingAlert;
    await saveIncident(key, previous, abortSignal);
  }
  const observations: LoopObservation[] = rows.flatMap((row) => {
    if (!row?.payload) return [];
    const parsed = parseLoopObservation(row.payload);
    const baselineAt = record(row.payload).baselineAt;
    return [
      { ...parsed, ...(typeof baselineAt === 'number' ? { baselineAt } : {}) }
    ];
  });
  const assessment = {
    ...assessLoop(
      policy,
      observations,
      record(throttle?.payload).active === true,
      now,
      previous.open === true && previous.scope === 'processing'
    ),
    expectedOverlap: policy.expectedOverlap
  };
  const recovery = previous.open === true && assessment.level === 'healthy';
  if (
    !recovery &&
    (assessment.level === 'healthy' ||
      (previous.open === true &&
        previous.level === assessment.level &&
        previous.reason === assessment.reason &&
        previous.operation === assessment.operation &&
        previous.recovery === assessment.recovery))
  )
    return;
  const next = {
    open: !recovery,
    level: assessment.level,
    reason: assessment.reason,
    operation: assessment.operation,
    recovery: assessment.recovery,
    scope: assessment.scope,
    pendingAlert: loopAlert(env, policy.service, assessment, now, recovery)
  };
  await saveIncident(key, next, abortSignal);
  await enqueue(
    { kind: 'alert', alert: next.pendingAlert },
    true,
    0,
    abortSignal
  );
  const { pendingAlert: _pending, ...settled } = next;
  await saveIncident(key, settled, abortSignal);
}

export async function monitorLoops(
  env: Environment,
  now: number
): Promise<void> {
  // Five workers drain the catalog without waiting for the slowest item in each batch.
  // A catalog-wide deadline bounds this new monitoring work within Probe's
  // unchanged 90-second timeout. Failure skips the external check-in and alerts
  // through the existing monitor failure/deadman path; pending sends stay durable.
  const abortSignal = AbortSignal.timeout(20000);
  const pending = [...policiesFor(env)];
  const worker = async (): Promise<void> => {
    const policy = pending.shift();
    if (!policy) return;
    await monitorLoop(policy, env, now, abortSignal);
    return worker();
  };
  await Promise.all(Array.from({ length: 5 }, worker));
}
