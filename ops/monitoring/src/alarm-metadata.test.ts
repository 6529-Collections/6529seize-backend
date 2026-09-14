import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudWatchAlarmMetadata } from './alarm-metadata.js';
import { parseAlert, renderAlert } from './contract.js';
import { fixture } from './contract.test.js';

const detail = {
  alarmName: 'seize-monitoring-prod-waveScoreRefreshLoop-Throttles',
  configuration: {
    description: 'PRIVATE_DESCRIPTION',
    metrics: [
      {
        metricStat: {
          metric: {
            namespace: 'AWS/Lambda',
            name: 'Throttles',
            dimensions: {
              FunctionName: 'waveScoreRefreshLoop',
              private: 'PRIVATE_DIMENSION'
            }
          },
          period: 60,
          stat: 'Sum'
        }
      }
    ]
  },
  state: {
    reason: 'PRIVATE_REASON',
    reasonData: JSON.stringify({ threshold: 1, private: 'PRIVATE_JSON' })
  }
};

test('AWS metric alarm metadata survives queue parsing and renders bounded diagnostic fields', () => {
  const alarm = cloudWatchAlarmMetadata(detail);
  assert.deepEqual(alarm, {
    name: detail.alarmName,
    namespace: 'AWS/Lambda',
    metric: 'Throttles',
    statistic: 'Sum',
    periodSeconds: 60,
    threshold: 1
  });
  for (const code of ['PLATFORM_ALARM', 'PLATFORM_RECOVERY']) {
    const alert = parseAlert({ ...fixture, code, alarm });
    assert.deepEqual(alert.alarm, alarm);
    const rendered = renderAlert(alert) as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const fields = rendered.embeds[0]!.fields;
    assert.deepEqual(
      fields.find((field) => field.name === 'Metric'),
      { name: 'Metric', value: 'Throttles' }
    );
    assert.deepEqual(
      fields.find((field) => field.name === 'Datapoint threshold'),
      { name: 'Datapoint threshold', value: '1' }
    );
    assert.ok(fields.length <= 25);
    assert.ok(fields.every((field) => field.value.length <= 1024));
    assert.equal(JSON.stringify(rendered).includes('PRIVATE'), false);
  }
});

test('arbitrary metadata, descriptions, malformed thresholds and unsupported labels never propagate', () => {
  for (const reasonData of [
    'not-json',
    'x'.repeat(8193),
    '{"threshold":"PRIVATE"}',
    '{"threshold":1e400}'
  ]) {
    assert.equal(
      cloudWatchAlarmMetadata({ ...detail, state: { reasonData } })?.threshold,
      undefined
    );
  }
  const alert = parseAlert({
    ...fixture,
    code: 'PLATFORM_ALARM',
    alarm: {
      name: '@everyone',
      namespace: 'x'.repeat(129),
      metric: 'PRIVATE metric',
      statistic: 'https://secret.example/PRIVATE',
      periodSeconds: -1,
      threshold: Infinity,
      evidence: 'PRIVATE'
    }
  });
  assert.equal(alert.alarm, undefined);
  assert.equal(
    parseAlert({ ...fixture, alarm: cloudWatchAlarmMetadata(detail) }).alarm,
    undefined
  );
  assert.equal(
    cloudWatchAlarmMetadata({ ...detail, alarmName: 'x'.repeat(256) })?.name,
    undefined
  );
});

test('metric math and composite alarms retain identity without incorrectly labeling an input metric', () => {
  for (const configuration of [
    {
      metrics: [
        ...detail.configuration.metrics,
        { expression: 'PRIVATE_EXPRESSION' }
      ]
    },
    { alarmRule: 'PRIVATE_RULE' }
  ]) {
    assert.deepEqual(cloudWatchAlarmMetadata({ ...detail, configuration }), {
      name: detail.alarmName,
      threshold: 1
    });
  }
});
