import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessLoop,
  LOOP_EVENT_TYPE,
  LoopObservation,
  LoopPolicy,
  parseLoopObservation
} from './loop-health.js';
import { Alert, EVENT_TYPE, parseAlert, renderAlert } from './contract.js';

const policy: LoopPolicy = {
  service: 'delegationsLoop',
  operations: ['indexing'],
  expectedOverlap: true,
  intervalSeconds: 60,
  reservedConcurrency: 1,
  delaySeconds: 600,
  stallSeconds: 1200,
  freshSeconds: 1020
};
const now = 20000;
const observation: LoopObservation = {
  _type: LOOP_EVENT_TYPE,
  service: policy.service,
  operation: 'indexing',
  observedAt: now,
  progressAt: now - 120,
  oldestPendingAt: now - 180,
  pending: true,
  recovery: 'automatic'
};

test('routine multi-minute overlap remains silent, and clearing its throttle does not create an incident', () => {
  for (const active of [true, false]) {
    const result = assessLoop(policy, [observation], active, now);
    assert.equal(result.level, 'healthy');
    assert.equal(result.reason, 'overlap');
  }
});
test('old backlog warns despite recent progress; stale progress escalates independently of throttles', () => {
  const delayed = { ...observation, oldestPendingAt: now - 900 };
  assert.equal(assessLoop(policy, [delayed], true, now).reason, 'delayed');
  assert.equal(
    assessLoop(policy, [{ ...delayed, progressAt: now - 1201 }], false, now)
      .reason,
    'stalled'
  );
  // An old watermark is backlog evidence, not evidence that this new attempt has stalled.
  assert.equal(
    assessLoop(
      policy,
      [{ ...delayed, progressAt: undefined, baselineAt: now - 60 }],
      true,
      now
    ).level,
    'amber'
  );
});
test('deadline and unavailable recovery override a moving worker and the overlap window', () => {
  assert.equal(
    assessLoop(policy, [{ ...observation, deadlineAt: now + 30 }], true, now)
      .reason,
    'deadline'
  );
  for (const recovery of ['exhausted', 'unavailable'] as const)
    assert.equal(
      assessLoop(policy, [{ ...observation, recovery }], true, now).reason,
      'recovery_failed'
    );
});

test('a future decision remembered by the last idle survey becomes due independently of a hung worker', () => {
  const decisionPolicy = {
    ...policy,
    freshSeconds: 120,
    delaySeconds: 120,
    stallSeconds: 300
  };
  const idle = {
    ...observation,
    pending: false,
    oldestPendingAt: undefined,
    observedAt: now - 400,
    progressAt: now - 400,
    nextDueAt: now - 250,
    deadlineAt: now + 50
  };
  assert.equal(
    assessLoop(decisionPolicy, [idle], true, now).reason,
    'deadline'
  );
  assert.equal(
    assessLoop(
      decisionPolicy,
      [{ ...idle, nextDueAt: now + 1000, deadlineAt: now + 1300 }],
      false,
      now
    ).reason,
    'telemetry_stale'
  );
});
test('successful handler/maintenance return, quiet metrics and stale telemetry cannot manufacture business recovery', () => {
  assert.equal(assessLoop(policy, [], true, now).reason, 'unconfirmed');
  assert.equal(assessLoop(policy, [], false, now, true).level, 'amber');
  assert.equal(assessLoop(policy, [], false, now, true).scope, 'processing');
  const stale = {
    ...observation,
    pending: false,
    oldestPendingAt: undefined,
    observedAt: now - 1021,
    progressAt: now - 1021
  };
  assert.equal(
    assessLoop(policy, [stale], false, now).reason,
    'telemetry_stale'
  );
  const maintenancePolicy = {
    ...policy,
    operations: ['indexing', 'recalculation'],
    optionalOperations: ['recalculation']
  };
  assert.equal(
    assessLoop(
      maintenancePolicy,
      [
        observation,
        { ...observation, operation: 'recalculation', pending: false }
      ],
      false,
      now
    ).reason,
    'overlap'
  );
});
test('one advancing operation does not hide another blocked operation; unused maintenance is optional', () => {
  const multi = { ...policy, operations: ['indexing', 'publication'] };
  assert.equal(assessLoop(multi, [observation], true, now).level, 'amber');
  assert.equal(
    assessLoop(
      multi,
      [
        observation,
        { ...observation, operation: 'publication', recovery: 'exhausted' }
      ],
      true,
      now
    ).level,
    'red'
  );
  const optional = {
    ...policy,
    operations: ['indexing', 'recalculation'],
    optionalOperations: ['recalculation']
  };
  assert.equal(assessLoop(optional, [observation], true, now).level, 'healthy');
});
test('verified idle is healthy; a completed old scan still exposes its stale watermark', () => {
  const idle = {
    ...observation,
    pending: false,
    oldestPendingAt: undefined,
    watermarkAt: now - 30
  };
  assert.equal(assessLoop(policy, [idle], false, now).reason, 'caught_up');
  assert.equal(
    assessLoop(policy, [{ ...idle, watermarkAt: now - 900 }], false, now)
      .reason,
    'delayed'
  );
});
test('loop envelopes retain only finite metadata and reject malformed/future progress', () => {
  const parsed = parseLoopObservation({
    ...observation,
    privateMessage: 'PRIVATE',
    baselineAt: 1
  });
  assert.equal('privateMessage' in parsed, false);
  assert.equal('baselineAt' in parsed, false);
  for (const extra of [
    { progressAt: now + 1 },
    { oldestPendingAt: NaN },
    { recovery: 'success' },
    { operation: 'https://private' }
  ])
    assert.throws(() => parseLoopObservation({ ...observation, ...extra }));
});
test('notifications identify delay/recovery mechanism and distinguish contention clearance from business recovery', () => {
  const alert: Alert = {
    _type: EVENT_TYPE,
    service: policy.service,
    eventId: 'loop:test',
    environment: 'staging',
    severity: 'warning',
    code: 'LOOP_HEALTH',
    occurredAt: new Date().toISOString(),
    fingerprint: 'test',
    loop: assessLoop(
      policy,
      [{ ...observation, oldestPendingAt: now - 900 }],
      true,
      now
    )
  };
  const rendered = renderAlert(parseAlert(alert)) as {
    embeds: { color: number; description: string }[];
  };
  assert.equal(rendered.embeds[0]?.color, 0xf59e0b);
  assert.match(rendered.embeds[0]!.description, /persisted checkpoint/);
  const recovered = renderAlert({
    ...alert,
    severity: 'recovery',
    code: 'LOOP_RECOVERY',
    loop: {
      level: 'healthy',
      reason: 'contention_cleared',
      operation: 'processing',
      scope: 'contention'
    }
  });
  assert.match(
    JSON.stringify(recovered),
    /Business catch-up has not been verified/
  );
});

test('per-operation delay, freshness and stall overrides do not leak to other operations', () => {
  const multi = {
    ...policy,
    operations: ['indexing', 'publication'],
    operationBudgets: {
      publication: { delaySeconds: 60, stallSeconds: 300, freshSeconds: 30 }
    }
  };
  const publication = { ...observation, operation: 'publication' };
  assert.equal(
    assessLoop(multi, [observation, publication], false, now).reason,
    'delayed'
  );
  assert.equal(
    assessLoop(
      multi,
      [observation, { ...publication, observedAt: now - 60 }],
      false,
      now
    ).reason,
    'telemetry_stale'
  );
  const result = assessLoop(
    multi,
    [observation, { ...publication, progressAt: now - 301 }],
    false,
    now
  );
  assert.equal(result.reason, 'stalled');
  assert.equal(result.operation, 'publication');
  assert.equal(
    assessLoop(
      { ...multi, operations: ['indexing'] },
      [observation],
      false,
      now
    ).level,
    'healthy'
  );
});

test('long native scans use their runtime allowance while overdue decisions still threaten deadlines', () => {
  const multi = {
    ...policy,
    operations: ['native_execution', 'decisions'],
    operationBudgets: { decisions: { delaySeconds: 120, freshSeconds: 120 } }
  };
  const native = {
    ...observation,
    operation: 'native_execution',
    observedAt: now - 600,
    progressAt: now - 600,
    oldestPendingAt: now - 600
  };
  const decision = {
    ...observation,
    operation: 'decisions',
    pending: false,
    oldestPendingAt: undefined,
    nextDueAt: now + 600,
    deadlineAt: now + 900
  };
  assert.equal(
    assessLoop(multi, [native, decision], true, now).level,
    'healthy'
  );
  const late = {
    ...decision,
    pending: true,
    oldestPendingAt: now - 400,
    progressAt: now - 1500,
    deadlineAt: now - 100
  };
  assert.equal(assessLoop(multi, [native, late], true, now).reason, 'deadline');
});

test('empty policy inventories return a safe contention-only assessment', () => {
  assert.equal(
    assessLoop({ ...policy, operations: [] }, [], false, now).reason,
    'contention_cleared'
  );
});

test('wave score overlap is silent only with fresh dirty evidence and no stalled full scan', () => {
  const scorePolicy = {
    ...policy,
    service: 'waveScoreRefreshLoop',
    operations: ['dirty_refresh', 'full_refresh'],
    optionalOperations: ['full_refresh']
  };
  const dirty = { ...observation, operation: 'dirty_refresh', pending: false };
  assert.equal(assessLoop(scorePolicy, [], true, now).level, 'amber');
  assert.equal(assessLoop(scorePolicy, [dirty], true, now).level, 'healthy');
  const full = {
    ...observation,
    operation: 'full_refresh',
    oldestPendingAt: now - 700
  };
  assert.equal(
    assessLoop(scorePolicy, [dirty, full], true, now).reason,
    'delayed'
  );
  assert.equal(
    assessLoop(
      scorePolicy,
      [dirty, { ...full, progressAt: now - 1201 }],
      false,
      now
    ).reason,
    'stalled'
  );
  assert.equal(
    assessLoop(scorePolicy, [dirty, { ...full, pending: false }], true, now)
      .level,
    'healthy'
  );
});

test('event-driven idle surveys do not expire into noise, but cannot hide new contention', () => {
  const idlePolicy = {
    ...policy,
    operations: ['processing'],
    idleOperations: ['processing']
  };
  const idle = {
    ...observation,
    operation: 'processing',
    pending: false,
    observedAt: now - 5000,
    progressAt: undefined,
    oldestPendingAt: undefined
  };
  assert.equal(assessLoop(idlePolicy, [idle], false, now).level, 'healthy');
  assert.equal(
    assessLoop(idlePolicy, [idle], true, now).reason,
    'telemetry_stale'
  );
  assert.equal(
    assessLoop(idlePolicy, [{ ...idle, observedAt: now }], true, now).level,
    'healthy'
  );
  assert.equal(
    assessLoop(idlePolicy, [{ ...idle, pending: true }], false, now).reason,
    'stalled'
  );
});

test('a successful NFT discovery cannot clear a stuck refresh or audit', () => {
  const modes = { ...policy, operations: ['discovery', 'refresh', 'audit'] };
  const result = assessLoop(
    modes,
    [
      { ...observation, operation: 'discovery', pending: false },
      { ...observation, operation: 'refresh', pending: false },
      { ...observation, operation: 'audit', progressAt: now - 1300 }
    ],
    true,
    now
  );
  assert.equal(result.level, 'red');
  assert.equal(result.operation, 'audit');
});
