import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EventBridgeEvent } from 'aws-lambda';
import { S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { hash, record } from './contract.js';
import {
  classifyLowCpuControl,
  LOW_CPU_CONTROLS,
  type LowCpuControlRule
} from './low-cpu-controls.js';
import { collect, collectAlarm } from './handlers.js';
import { sqs } from './aws.js';

const dimensions = { AutoScalingGroupName: 'synthetic-group' };
const testEnv = {
  ENVIRONMENT: 'prod',
  ARCHIVE_BUCKET: 'synthetic-archive',
  CRITICAL_QUEUE_URL: 'synthetic-critical',
  SOURCE_ACCOUNTS: '123456789012',
  SOURCE_REGION: 'us-east-1'
};
let previousEnv: Record<string, string | undefined>;
beforeEach(() => {
  previousEnv = Object.fromEntries(
    Object.keys(testEnv).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, testEnv);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const rule: LowCpuControlRule = {
  id: 'EC2_SUM_LOW_CPU',
  identityHash: hash('123456789012:us-east-1:synthetic-low'),
  dimensionsHash: hash(JSON.stringify(Object.entries(dimensions))),
  namespace: 'AWS/EC2',
  statistic: 'Sum',
  period: 60,
  evaluations: 1,
  threshold: 20
};

// AWS-authored state grammar, with infrastructure identity/measurements replaced.
function state(policy: LowCpuControlRule, recovery = false) {
  const values = Array.from({ length: policy.evaluations }, (_, i) => i + 1);
  if (recovery) values[values.length - 1] = policy.threshold + 1;
  const date = (i: number) =>
    new Date(Date.UTC(2026, 8, 14, 0, i)).toISOString();
  const points = values
    .map((value, i) => ({ value, timestamp: date(i), sampleCount: 1 }))
    .reverse();
  const evaluated = recovery ? points.slice(0, 1) : points;
  const rendered = (point: (typeof points)[number]) =>
    `${point.value} (14/09/26 ${point.timestamp.slice(11, 19)})`;
  const reason =
    recovery || policy.evaluations === 1
      ? `Threshold Crossed: 1 datapoint [${rendered(evaluated[0]!)}] was ${recovery ? 'not ' : ''}less than the threshold (${policy.threshold.toFixed(1)}).`
      : `Threshold Crossed: ${policy.evaluations} datapoints were less than the threshold (${policy.threshold.toFixed(1)}). The most recent datapoints which crossed the threshold: [${points.slice(0, 5).map(rendered).join(', ')}].`;
  return {
    value: recovery ? 'OK' : 'ALARM',
    reason,
    reasonData: JSON.stringify({
      version: '1.0',
      queryDate: date(20),
      startDate: date(0),
      unit: 'Percent',
      statistic: policy.statistic,
      period: policy.period,
      threshold: policy.threshold,
      recentDatapoints: values,
      evaluatedDatapoints: evaluated
    })
  };
}

function fixture(
  policy = rule,
  recovery = false
): EventBridgeEvent<string, Record<string, unknown>> {
  return {
    version: '0',
    id: 'synthetic-event',
    account: '123456789012',
    region: 'us-east-1',
    time: '2026-09-14T00:21:00Z',
    resources: [],
    source: 'aws.cloudwatch',
    'detail-type': 'CloudWatch Alarm State Change',
    detail: {
      alarmName: 'synthetic-low',
      state: state(policy, recovery),
      previousState: recovery ? state(policy) : { value: 'OK' },
      configuration: {
        metrics: [
          {
            id: 'm1',
            returnData: true,
            metricStat: {
              metric: {
                name: 'CPUUtilization',
                namespace: policy.namespace,
                dimensions: { ...dimensions }
              },
              stat: policy.statistic,
              period: policy.period
            }
          }
        ]
      }
    }
  };
}
const detail = (event: ReturnType<typeof fixture>) => event.detail;
const alarmState = (event: ReturnType<typeof fixture>) =>
  record(event.detail.state);
const configuration = (event: ReturnType<typeof fixture>) =>
  record(event.detail.configuration);
const metricEntry = (event: ReturnType<typeof fixture>) =>
  record((configuration(event).metrics as unknown[])[0]);
const metricStat = (event: ReturnType<typeof fixture>) =>
  record(metricEntry(event).metricStat);
const metric = (event: ReturnType<typeof fixture>) =>
  record(metricStat(event).metric);

test('policy pins exactly three distinct reviewed control identities', () => {
  assert.equal(LOW_CPU_CONTROLS.length, 3);
  assert.equal(
    new Set(LOW_CPU_CONTROLS.map((entry) => entry.identityHash)).size,
    3
  );
  assert.equal(classifyLowCpuControl(fixture(), 'prod'), undefined);
});

for (const policy of [
  rule,
  { ...rule, statistic: 'Average', period: 300 },
  {
    ...rule,
    namespace: 'AWS/RDS',
    statistic: 'Average',
    evaluations: 15,
    threshold: 45
  }
]) {
  for (const recovery of [false, true])
    test(`observed ${policy.namespace}/${policy.statistic}/${policy.period}/${recovery ? 'recovery' : 'alarm'} is positively classified`, () => {
      assert.equal(
        classifyLowCpuControl(fixture(policy, recovery), 'prod', [policy]),
        policy
      );
    });
}

const changes: Record<string, (event: ReturnType<typeof fixture>) => void> = {
  account: (e) => {
    e.account = '999999999999';
  },
  region: (e) => {
    e.region = 'eu-west-1';
  },
  source: (e) => {
    e.source = '6529.ops';
  },
  type: (e) => {
    e['detail-type'] = 'other';
  },
  renamed: (e) => {
    detail(e).alarmName = `${detail(e).alarmName}-new`;
  },
  namespace: (e) => {
    metric(e).namespace = 'AWS/Lambda';
  },
  failureMetric: (e) => {
    metric(e).name = 'Errors';
  },
  dimensions: (e) => {
    metric(e).dimensions = { AutoScalingGroupName: 'changed' };
  },
  addedDimension: (e) => {
    record(metric(e).dimensions).Extra = 'changed';
  },
  statistic: (e) => {
    metricStat(e).stat = 'Maximum';
  },
  period: (e) => {
    metricStat(e).period = 120;
  },
  unit: (e) => {
    metricStat(e).unit = 'Count';
  },
  composite: (e) => {
    (configuration(e).metrics as unknown[]).push({ expression: 'm1' });
  },
  expression: (e) => {
    metricEntry(e).expression = 'm1';
  },
  futureConfiguration: (e) => {
    configuration(e).comparisonOperator = 'GreaterThanThreshold';
  },
  failedActionMetadata: (e) => {
    detail(e).actionState = 'FAILED';
  },
  unknownStateMetadata: (e) => {
    alarmState(e).actionResult = 'unknown';
  },
  unknownPreviousMetadata: (e) => {
    record(detail(e).previousState).actionResult = 'FAILED';
  },
  partial: (e) => {
    delete detail(e).configuration;
  },
  noReason: (e) => {
    delete alarmState(e).reason;
  },
  highDirection: (e) => {
    alarmState(e).reason = String(alarmState(e).reason).replace(
      'less than',
      'greater than'
    );
  },
  negativeDirection: (e) => {
    alarmState(e).reason = String(alarmState(e).reason).replace(
      'was less than',
      'was not less than'
    );
  },
  alteredThreshold: (e) => {
    const d = JSON.parse(String(alarmState(e).reasonData));
    d.threshold = 21;
    alarmState(e).reasonData = JSON.stringify(d);
  },
  unknownGrammar: (e) => {
    alarmState(e).reason = `${alarmState(e).reason} Additional detail.`;
  },
  malformedJson: (e) => {
    alarmState(e).reasonData = '{broken';
  },
  oversizedReasonData: (e) => {
    alarmState(e).reasonData = 'x'.repeat(8193);
  },
  insufficientData: (e) => {
    alarmState(e).value = 'INSUFFICIENT_DATA';
  }
};
for (const [name, change] of Object.entries(changes))
  test(`${name} remains an alert`, () => {
    const event = fixture();
    change(event);
    assert.equal(classifyLowCpuControl(event, 'prod', [rule]), undefined);
  });

for (const value of [null, '1', -1, NaN, Infinity])
  test(`nonnumeric/nonfinite/inconsistent point ${String(value)} stays alerting`, () => {
    const event = fixture();
    const data = JSON.parse(String(alarmState(event).reasonData));
    data.recentDatapoints[0] = value;
    data.evaluatedDatapoints[0].value = value;
    alarmState(event).reasonData = JSON.stringify(data);
    assert.equal(classifyLowCpuControl(event, 'prod', [rule]), undefined);
  });

test('recovery requires a complete positively matched previous low ALARM', () => {
  for (const previous of [
    undefined,
    {},
    { value: 'OK' },
    { value: 'ALARM' },
    { ...state(rule), reason: 'unknown' }
  ]) {
    const event = fixture(rule, true);
    event.detail.previousState = previous;
    assert.equal(classifyLowCpuControl(event, 'prod', [rule]), undefined);
  }
  assert.equal(classifyLowCpuControl(fixture(), 'staging', [rule]), undefined);
});

test('partial, inconsistent, nonfinite and future numeric evidence stays alerting', () => {
  const mutate: ((data: Record<string, unknown>) => void)[] = [
    (data) => {
      delete data.evaluatedDatapoints;
    },
    (data) => {
      data.recentDatapoints = [];
    },
    (data) => {
      data.startDate = '2026-02-30T00:00:00Z';
    },
    (data) => {
      data.queryDate = '2026-09-13T00:00:00Z';
    },
    (data) => {
      data.actionResult = 'FAILED';
    },
    (data) => {
      record((data.evaluatedDatapoints as unknown[])[0]).sampleCount = 0;
    },
    (data) => {
      record((data.evaluatedDatapoints as unknown[])[0]).value = 2;
    },
    (data) => {
      record((data.evaluatedDatapoints as unknown[])[0]).timestamp = 'invalid';
    },
    (data) => {
      record((data.evaluatedDatapoints as unknown[])[0]).actionResult =
        'unknown';
    }
  ];
  for (const change of mutate) {
    const event = fixture();
    const data = record(JSON.parse(String(alarmState(event).reasonData)));
    change(data);
    alarmState(event).reasonData = JSON.stringify(data);
    assert.equal(classifyLowCpuControl(event, 'prod', [rule]), undefined);
  }
  const event = fixture();
  // JSON permits an exponent that parses to Infinity; serialization would hide it.
  alarmState(event).reasonData = String(alarmState(event).reasonData).replace(
    '"sampleCount":1',
    '"sampleCount":1e999'
  );
  assert.equal(classifyLowCpuControl(event, 'prod', [rule]), undefined);
});

test('multi-point alarms and recoveries reject changed or incomplete prior evidence', () => {
  const policy = { ...rule, evaluations: 15, threshold: 45 };
  for (const recovery of [false, true]) {
    const event = fixture(policy, recovery);
    const target = record(
      recovery ? event.detail.previousState : event.detail.state
    );
    const data = record(JSON.parse(String(target.reasonData)));
    data.threshold = 46;
    target.reasonData = JSON.stringify(data);
    assert.equal(classifyLowCpuControl(event, 'prod', [policy]), undefined);
  }
  const event = fixture(policy);
  const data = record(JSON.parse(String(alarmState(event).reasonData)));
  (data.evaluatedDatapoints as unknown[]).pop();
  alarmState(event).reasonData = JSON.stringify(data);
  assert.equal(classifyLowCpuControl(event, 'prod', [policy]), undefined);
});

test('collector archives only sanitized control evidence with no queue, webhook or benign fallback; replay has same object key/body', async () => {
  process.env.ENVIRONMENT = 'prod';
  process.env.ARCHIVE_BUCKET = 'synthetic-archive';
  const writes: PutObjectCommandInput[] = [];
  const output: string[] = [];
  const s3 = mock.method(
    S3Client.prototype,
    'send',
    async (command: { input: PutObjectCommandInput }) => {
      writes.push(command.input);
      return {};
    }
  );
  const queue = mock.method(sqs, 'send', async () => {
    throw Error('Unexpected queue');
  });
  const sns = mock.method(SNSClient.prototype, 'send', async () => {
    throw Error('Unexpected fallback');
  });
  const secret = mock.method(
    SecretsManagerClient.prototype,
    'send',
    async () => {
      throw Error('Unexpected provider');
    }
  );
  const logs = mock.method(console, 'log', (line: string) => {
    output.push(line);
  });
  try {
    const event = fixture();
    configuration(event).description = 'private-canary';
    await collectAlarm(event, [rule]);
    await collectAlarm(event, [rule]);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(
      writes[0]!.Key,
      `controls/v1/${hash('alarm:synthetic-event')}.json`
    );
    assert.equal(writes[0]!.ServerSideEncryption, 'AES256');
    const body = JSON.parse(String(writes[0]!.Body));
    assert.equal(body.policy, 'known-low-cpu-control/v1');
    assert.equal(body.rule, rule.id);
    assert.equal(body.alert.code, 'PLATFORM_ALARM');
    assert.doesNotMatch(
      String(writes[0]!.Body),
      /private-canary|Threshold Crossed|reasonData|AutoScalingGroupName/
    );
    assert.equal(output.length, 2);
    assert.equal(JSON.parse(output[0]!).LowCpuControlAudited, 1);
    assert.equal(queue.mock.callCount(), 0);
    assert.equal(sns.mock.callCount(), 0);
    assert.equal(secret.mock.callCount(), 0);
  } finally {
    s3.mock.restore();
    queue.mock.restore();
    sns.mock.restore();
    secret.mock.restore();
    logs.mock.restore();
  }
});

test('a proven recovery is archived without posting its recovery notification', async () => {
  const writes: PutObjectCommandInput[] = [];
  const s3 = mock.method(
    S3Client.prototype,
    'send',
    async (command: { input: PutObjectCommandInput }) => {
      writes.push(command.input);
      return {};
    }
  );
  const queue = mock.method(sqs, 'send', async () => {
    throw Error('Unexpected recovery post');
  });
  const logs = mock.method(console, 'log', () => {});
  try {
    await collectAlarm(fixture(rule, true), [rule]);
    assert.equal(writes.length, 1);
    assert.equal(
      JSON.parse(String(writes[0]!.Body)).alert.code,
      'PLATFORM_RECOVERY'
    );
    assert.equal(queue.mock.callCount(), 0);
    assert.equal(logs.mock.callCount(), 1);
  } finally {
    s3.mock.restore();
    queue.mock.restore();
    logs.mock.restore();
  }
});

test('archive failure rejects the original operation and emits no successful-audit counter', async () => {
  const failure = new Error('synthetic archive failure');
  const s3 = mock.method(S3Client.prototype, 'send', async () => {
    throw failure;
  });
  const logs = mock.method(console, 'log', () => {});
  try {
    await assert.rejects(
      collectAlarm(fixture(), [rule]),
      (error) => error === failure
    );
    assert.equal(logs.mock.callCount(), 0);
  } finally {
    s3.mock.restore();
    logs.mock.restore();
  }
});

test('changed controls and normal protected failures retain the critical queue path; source trust checks remain enforced', async () => {
  process.env.CRITICAL_QUEUE_URL = 'synthetic-critical';
  process.env.SOURCE_ACCOUNTS = '123456789012';
  process.env.SOURCE_REGION = 'us-east-1';
  const queued: { QueueUrl?: string; MessageBody?: string }[] = [];
  const queue = mock.method(
    sqs,
    'send',
    async (command: { input: { QueueUrl?: string; MessageBody?: string } }) => {
      queued.push(command.input);
      return {};
    }
  );
  const s3 = mock.method(S3Client.prototype, 'send', async () => {
    throw Error('Unexpected archive');
  });
  try {
    const event = fixture();
    changes.highDirection!(event);
    await collectAlarm(event, [rule]);
    assert.equal(queued[0]!.QueueUrl, 'synthetic-critical');
    assert.equal(
      JSON.parse(queued[0]!.MessageBody!).alert.severity,
      'critical'
    );
    const recovery = fixture(rule, true);
    recovery.detail.previousState = { value: 'ALARM' };
    await collectAlarm(recovery, [rule]);
    assert.equal(queued.length, 2);
    assert.equal(
      JSON.parse(queued[1]!.MessageBody!).alert.severity,
      'recovery'
    );
    // Preserve the collector's existing handling of non-ALARM-to-OK transitions.
    delete recovery.detail.previousState;
    await collectAlarm(recovery, [rule]);
    assert.equal(queued.length, 2);
    event.account = '999999999999';
    await assert.rejects(collect(event), /UNAPPROVED_SOURCE/);
    assert.equal(s3.mock.callCount(), 0);
  } finally {
    queue.mock.restore();
    s3.mock.restore();
  }
});
