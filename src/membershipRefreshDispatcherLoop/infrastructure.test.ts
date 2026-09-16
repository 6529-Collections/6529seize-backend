import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Resource = {
  Type: string;
  Properties: Record<string, unknown>;
  DependsOn?: string | string[];
  Condition?: string;
};
type Statement = { Action: string | string[]; Resource: unknown };
type Template = {
  Resources: Record<string, Resource>;
  Conditions: Record<string, unknown>;
};

function compile(
  stage: 'staging' | 'prod',
  mode = 'inactive',
  schedule = 'false'
): Template {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'membership-dispatcher-cf-')
  );
  const fixture = path.join(directory, 'index.js');
  const artifact = path.join(directory, 'index.zip');
  const config = path.join(
    __dirname,
    `serverless.${path.basename(directory)}.yaml`
  );
  try {
    // Compilation proves infrastructure only; the actual handler is built separately.
    writeFileSync(
      fixture,
      'exports.handler = async () => ({ inactive: true });\n'
    );
    const zip = spawnSync('zip', ['-q', '-j', artifact, fixture], {
      encoding: 'utf8'
    });
    if (zip.status !== 0)
      throw new Error(`Fixture archive failed: ${zip.stderr}`);
    writeFileSync(
      config,
      readFileSync(path.join(__dirname, 'serverless.yaml'), 'utf8').replace(
        'artifact: dist/index.zip',
        `artifact: ${artifact}`
      )
    );
    const output = path.join(directory, 'package');
    const result = spawnSync(
      path.resolve(__dirname, '../../bin/6529'),
      [
        'exec',
        'serverless',
        'package',
        '--config',
        path.basename(config),
        '--stage',
        stage,
        '--region',
        stage === 'staging' ? 'eu-west-1' : 'us-east-1',
        '--package',
        output
      ],
      {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 25000,
        env: {
          ...process.env,
          VERSION_DESCRIPTION: 'membership-infrastructure-test',
          SENTRY_DSN: '',
          AWS_EC2_METADATA_DISABLED: 'true',
          SLS_TELEMETRY_DISABLED: '1',
          SLS_DEPRECATION_DISABLE: '*',
          MEMBERSHIP_RUNTIME_MODE: mode,
          MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: schedule
        }
      }
    );
    if (result.status !== 0)
      throw new Error(
        `Serverless compilation failed: ${result.error ?? result.stderr}`
      );
    return JSON.parse(
      readFileSync(
        path.join(output, 'cloudformation-template-update-stack.json'),
        'utf8'
      )
    ) as Template;
  } finally {
    rmSync(config, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

const functionId = 'MembershipRefreshDispatcherLoopLambdaFunction';
const failureQueueArn = {
  'Fn::GetAtt': ['MembershipDispatcherFailureQueue', 'Arn']
};
const functionArn = { 'Fn::GetAtt': [functionId, 'Arn'] };
const ruleArn = (stage: string) => ({
  'Fn::Sub': `arn:\${AWS::Partition}:events:\${AWS::Region}:\${AWS::AccountId}:rule/membership-refresh-dispatch-${stage}-v1`
});
const queueImport = (stage: string, value: 'Arn' | 'Url') => ({
  'Fn::ImportValue': `membershipRefreshLoop-${stage}-WorkQueue${value}-v1`
});

function assertPermissions(resources: Template['Resources'], stage: string) {
  expect(
    Object.values(resources).filter((r) => r.Type === 'AWS::IAM::Role')
  ).toHaveLength(1);
  const role = resources.MembershipDispatcherRole.Properties;
  expect(role.AssumeRolePolicyDocument).toEqual({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole'
      }
    ]
  });
  expect(role.ManagedPolicyArns).toBeUndefined();
  const policies = role.Policies as {
    PolicyDocument: { Statement: Statement[] };
  }[];
  const statements = policies.flatMap((p) => p.PolicyDocument.Statement);
  expect(statements.flatMap((s) => s.Action)).toEqual([
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'ec2:CreateNetworkInterface',
    'ec2:DescribeNetworkInterfaces',
    'ec2:DescribeSubnets',
    'ec2:DeleteNetworkInterface',
    'ec2:AssignPrivateIpAddresses',
    'ec2:UnassignPrivateIpAddresses',
    'secretsmanager:GetSecretValue',
    'sqs:SendMessage'
  ]);
  expect(statements.filter((s) => s.Resource === '*')).toHaveLength(1);
  expect(statements[0].Resource).toEqual({
    'Fn::Sub':
      'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/membershipRefreshDispatcherLoop:*'
  });
  expect(
    statements.find((s) => s.Action === 'secretsmanager:GetSecretValue')
      ?.Resource
  ).toBe(
    stage === 'staging'
      ? 'arn:aws:secretsmanager:eu-west-1:987989283142:secret:prod/lambdas-qCUPVF'
      : 'arn:aws:secretsmanager:us-east-1:987989283142:secret:prod/lambdas-ZDzF7a'
  );
  expect(
    statements.find((s) => s.Action === 'sqs:SendMessage')?.Resource
  ).toEqual([queueImport(stage, 'Arn'), failureQueueArn]);
  expect(resources.MembershipDispatcherFailureQueuePolicy.Properties).toEqual({
    Queues: [{ Ref: 'MembershipDispatcherFailureQueue' }],
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: failureQueueArn,
          Condition: { ArnEquals: { 'aws:SourceArn': ruleArn(stage) } }
        }
      ]
    }
  });
}

function assertTransport(
  resources: Template['Resources'],
  stage: string,
  schedule: string
) {
  expect(
    Object.values(resources).filter((r) => r.Type === 'AWS::SQS::Queue')
  ).toHaveLength(1);
  expect(resources.MembershipDispatcherFailureQueue.Properties).toEqual({
    QueueName: `membership-refresh-dispatch-failures-${stage}-v1`,
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true
  });
  expect(resources.MembershipDispatcherInvokePermission.Properties).toEqual({
    FunctionName: { Ref: functionId },
    Action: 'lambda:InvokeFunction',
    Principal: 'events.amazonaws.com',
    SourceArn: ruleArn(stage)
  });
  expect(resources.MembershipDispatcherAsyncConfig.Properties).toEqual({
    FunctionName: { Ref: functionId },
    Qualifier: '$LATEST',
    MaximumEventAgeInSeconds: 60,
    MaximumRetryAttempts: 0,
    DestinationConfig: { OnFailure: { Destination: failureQueueArn } }
  });
  expect(resources.MembershipDispatcherSchedule).toMatchObject({
    Type: 'AWS::Events::Rule',
    DependsOn: [
      'MembershipDispatcherInvokePermission',
      'MembershipDispatcherFailureQueuePolicy',
      'MembershipDispatcherAsyncConfig'
    ],
    Properties: {
      Name: `membership-refresh-dispatch-${stage}-v1`,
      ScheduleExpression: 'rate(1 minute)',
      State: schedule === 'true' ? 'ENABLED' : 'DISABLED',
      Targets: [
        {
          Id: 'membership-dispatcher',
          Arn: functionArn,
          RetryPolicy: {
            MaximumEventAgeInSeconds: 60,
            MaximumRetryAttempts: 0
          },
          DeadLetterConfig: { Arn: failureQueueArn }
        }
      ]
    }
  });
  expect(
    Object.values(resources).filter((r) => r.Type === 'AWS::Events::Rule')
  ).toHaveLength(1);
  expect(
    Object.values(resources).filter(
      (r) => r.Type === 'AWS::Lambda::EventInvokeConfig'
    )
  ).toHaveLength(1);
}

function assertAlarms(template: Template, stage: string, schedule: string) {
  const alarms = Object.values(template.Resources).filter(
    (r) => r.Type === 'AWS::CloudWatch::Alarm'
  );
  expect(alarms).toHaveLength(12);
  for (const alarm of alarms) {
    expect(alarm.Properties).toMatchObject({
      Period: 60,
      AlarmActions: [
        stage === 'staging'
          ? 'arn:aws:sns:eu-west-1:987989283142:cloudwatch-alarms'
          : 'arn:aws:sns:us-east-1:987989283142:cloudwatch-alarms'
      ],
      TreatMissingData: alarm.Condition ? 'breaching' : 'notBreaching'
    });
  }
  expect(template.Conditions.DispatcherScheduleEnabled).toEqual({
    'Fn::Equals': [schedule === 'true' ? 'ENABLED' : 'DISABLED', 'ENABLED']
  });
  expect(template.Resources.MembershipDispatcherHeartbeatAlarm).toMatchObject({
    Condition: 'DispatcherScheduleEnabled',
    Properties: {
      MetricName: 'DispatchHeartbeat',
      EvaluationPeriods: 3,
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold'
    }
  });
  const emf = alarms.filter(
    (r) =>
      r.Properties.Namespace === 'Membership/Runtime' && r.Properties.Dimensions
  );
  expect(emf.map((r) => r.Properties.MetricName)).toEqual([
    'DispatchFailedSends',
    'DispatchOldestDueAgeSeconds',
    'DispatchParkedTargets',
    'GarbageCollectionFailures',
    'DispatchHeartbeat'
  ]);
  for (const alarm of emf)
    expect(alarm.Properties.Dimensions).toEqual([
      { Name: 'Stage', Value: stage },
      { Name: 'Service', Value: 'membershipRefreshDispatcherLoop' }
    ]);
  expect(
    template.Resources.MembershipDispatcherEventDlqDeliveryFailuresAlarm
      .Properties.MetricName
  ).toBe('InvocationsFailedToBeSentToDlq');
}

// Include references hidden in Fn::Sub and explicit DependsOn, not just Ref/GetAtt.
function localReferences(value: unknown, ids: Set<string>): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value))
    return value.flatMap((item) => localReferences(item, ids));
  const result: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (key === 'Ref' && typeof item === 'string' && ids.has(item))
      result.push(item);
    if (key === 'Fn::GetAtt' && Array.isArray(item) && ids.has(item[0]))
      result.push(item[0]);
    if (key === 'DependsOn')
      result.push(
        ...(Array.isArray(item) ? item : [item]).filter((id) => ids.has(id))
      );
    if (key === 'Fn::Sub' && typeof item === 'string') {
      for (const match of Array.from(
        item.matchAll(/\$\{([\w]+)(?:\.[\w]+)?\}/g)
      ))
        if (ids.has(match[1])) result.push(match[1]);
    }
    result.push(...localReferences(item, ids));
  }
  return result;
}

function assertAcyclic(resources: Template['Resources']) {
  const ids = new Set(Object.keys(resources));
  const done = new Set<string>();
  const visit = (id: string, parents: string[]) => {
    if (parents.includes(id))
      throw new Error(
        `CloudFormation dependency cycle: ${[...parents, id].join(' -> ')}`
      );
    if (done.has(id)) return;
    for (const dependency of localReferences(resources[id], ids))
      visit(dependency, [...parents, id]);
    done.add(id);
  };
  for (const id of Array.from(ids)) visit(id, []);
}

describe('compiled membership dispatcher infrastructure', () => {
  it.each([
    ['staging', 'inactive', 'false'],
    ['prod', 'inactive', 'false'],
    ['staging', 'staging-fixture-v1', 'true'],
    ['staging', 'staging-controlled-v1', 'false']
  ] as const)(
    'compiles %s/%s schedule %s with no privilege expansion or cycles',
    (stage, mode, schedule) => {
      const template = compile(stage, mode, schedule);
      const resources = template.Resources;
      expect(
        Object.values(resources).filter(
          (r) => r.Type === 'AWS::Lambda::Function'
        )
      ).toHaveLength(1);
      expect(resources[functionId].Properties).toMatchObject({
        Runtime: 'nodejs22.x',
        MemorySize: 512,
        Timeout: 30,
        Architectures: ['arm64'],
        ReservedConcurrentExecutions: 1,
        Role: { 'Fn::GetAtt': ['MembershipDispatcherRole', 'Arn'] },
        Environment: {
          Variables: {
            MEMBERSHIP_RUNTIME_STAGE: stage,
            MEMBERSHIP_RUNTIME_MODE: mode,
            MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: schedule,
            MEMBERSHIP_WORK_QUEUE_ARN: queueImport(stage, 'Arn'),
            MEMBERSHIP_WORK_QUEUE_URL: queueImport(stage, 'Url'),
            MEMBERSHIP_DISPATCH_RULE_ARN: ruleArn(stage)
          }
        }
      });
      expect(
        resources.MembershipRefreshDispatcherLoopLogGroup.Properties
      ).toMatchObject({
        LogGroupName: '/aws/lambda/membershipRefreshDispatcherLoop',
        RetentionInDays: 60
      });
      assertPermissions(resources, stage);
      assertTransport(resources, stage, schedule);
      assertAlarms(template, stage, schedule);
      assertAcyclic(resources);
      expect(
        Object.values(resources).some((r) =>
          [
            'AWS::Lambda::Url',
            'AWS::Lambda::EventSourceMapping',
            'AWS::ApiGateway::RestApi',
            'AWS::ApiGatewayV2::Api'
          ].includes(r.Type)
        )
      ).toBe(false);
    }
  );
  it('detects a function-to-rule cycle in the compiled graph checker', () => {
    expect(() =>
      assertAcyclic({
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { SourceArn: { 'Fn::Sub': '${Rule.Arn}' } }
        },
        Rule: {
          Type: 'AWS::Events::Rule',
          Properties: { Target: { 'Fn::GetAtt': ['Fn', 'Arn'] } }
        }
      })
    ).toThrow('dependency cycle');
  });
});
