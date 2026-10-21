import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  intervalSeconds,
  loopPolicies,
  policiesFromConfig
} from './loop-policies.mjs';

test('rates retain the known minute/hour/day cadence; cron remains unknown', () => {
  for (const [rate, seconds] of [
    ['rate(1 minute)', 60],
    ['rate(5 minutes)', 300],
    ['rate(2 hours)', 7200],
    ['rate(1 day)', 86400]
  ])
    assert.equal(intervalSeconds(rate), seconds);
  assert.equal(intervalSeconds('cron(0 12 * * ? *)'), undefined);
});

test('configuration read failures identify the service and preserve their original cause', async () => {
  await assert.rejects(
    loopPolicies(
      {
        services: [
          {
            name: 'missing-loop-policy-fixture',
            allowed_environments: ['staging'],
            deploy_adapter: 'serverless'
          }
        ]
      },
      'staging'
    ),
    (error) => {
      assert.match(error.message, /missing-loop-policy-fixture/);
      assert.equal(error.cause.code, 'ENOENT');
      return true;
    }
  );
});

test('queue-triggered schedules resolve GetAtt and Sub targets and ignore disabled rules', () => {
  const service = { verification_targets: ['worker'] };
  for (const arn of [
    { 'Fn::GetAtt': ['Queue', 'Arn'] },
    'Queue.Arn',
    '${Queue.Arn}',
    { 'Fn::Sub': '${Queue.Arn}' },
    { 'Fn::Sub': ['${Queue.Arn}', {}] }
  ]) {
    const config = {
      provider: { timeout: 900 },
      functions: {
        worker: {
          name: 'worker',
          reservedConcurrency: 1,
          events: [{ sqs: { arn: { 'Fn::GetAtt': ['Queue', 'Arn'] } } }]
        }
      },
      resources: {
        Resources: {
          Tick: {
            Type: 'AWS::Events::Rule',
            Properties: {
              ScheduleExpression: 'rate(5 minutes)',
              Targets: [{ Arn: arn }]
            }
          },
          Disabled: {
            Type: 'AWS::Events::Rule',
            Properties: {
              State: 'DISABLED',
              ScheduleExpression: 'rate(1 minute)',
              Targets: [{ Arn: arn }]
            }
          }
        }
      }
    };
    const [policy] = policiesFromConfig(service, config);
    assert.equal(policy.intervalSeconds, 300);
    assert.equal(policy.expectedOverlap, true);
    assert.equal(policy.stallSeconds, 1200);
    config.functions.worker.reservedConcurrency = 2;
    assert.equal(policiesFromConfig(service, config)[0].expectedOverlap, false);
  }
});

test('generated data matches both environments and separates scan budgets from known decision deadlines', async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL('../../../src/config/deploy-services.json', import.meta.url),
      'utf8'
    )
  );
  const generated = JSON.parse(
    await readFile(
      new URL('../src/loop-policies.generated.json', import.meta.url),
      'utf8'
    )
  );
  for (const env of ['prod', 'staging']) {
    assert.deepEqual(await loopPolicies(catalog, env), generated[env]);
    const policy = generated[env].find(
      (p) => p.service === 'waveDecisionExecutionLoop'
    );
    assert.equal(policy.stallSeconds, 1200);
    assert.equal(policy.freshSeconds, 1020);
    assert.equal(policy.operationBudgets.decisions.freshSeconds, 120);
    assert.equal(policy.operationBudgets.publication.stallSeconds, 3900);
  }
});
