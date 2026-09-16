import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Resource = { Type: string; Properties: Record<string, unknown> };
type Template = {
  Resources: Record<string, Resource>;
  Outputs: Record<string, unknown>;
};

function compile(
  stage: 'staging' | 'prod',
  mode = 'inactive',
  mapping = 'false'
): Template {
  const directory = mkdtempSync(path.join(tmpdir(), 'membership-worker-cf-'));
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
          MEMBERSHIP_WORKER_MAPPING_ENABLED: mapping
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

describe('compiled membership worker infrastructure', () => {
  it.each([
    ['staging', 'inactive', 'false'],
    ['prod', 'inactive', 'false'],
    ['staging', 'staging-fixture-v1', 'true'],
    ['staging', 'staging-controlled-v1', 'false']
  ] as const)(
    'compiles exact %s/%s mapping %s with a bounded dedicated role',
    (stage, mode, mapping) => {
      const template = compile(stage, mode, mapping);
      const resources = template.Resources;
      const lambda = resources.MembershipRefreshLoopLambdaFunction.Properties;
      expect(
        Object.values(resources).filter(
          (r) => r.Type === 'AWS::Lambda::Function'
        )
      ).toHaveLength(1);
      expect(lambda).toMatchObject({
        Runtime: 'nodejs22.x',
        MemorySize: 2048,
        Timeout: 60,
        Architectures: ['arm64'],
        ReservedConcurrentExecutions: 2,
        Role: { 'Fn::GetAtt': ['MembershipWorkerRole', 'Arn'] },
        Environment: {
          Variables: {
            MEMBERSHIP_RUNTIME_STAGE: stage,
            MEMBERSHIP_RUNTIME_MODE: mode,
            MEMBERSHIP_WORKER_MAPPING_ENABLED: mapping,
            MEMBERSHIP_WORK_QUEUE_ARN: {
              'Fn::GetAtt': ['MembershipWorkQueue', 'Arn']
            },
            MEMBERSHIP_WORK_QUEUE_URL: { Ref: 'MembershipWorkQueue' }
          }
        }
      });
      const mappings = Object.values(resources).filter(
        (r) => r.Type === 'AWS::Lambda::EventSourceMapping'
      );
      expect(mappings).toHaveLength(1);
      expect(mappings[0].Properties).toMatchObject({
        Enabled: mapping === 'true',
        BatchSize: 1,
        MaximumBatchingWindowInSeconds: 0,
        ScalingConfig: { MaximumConcurrency: 2 }
      });
      expect(resources.MembershipWorkQueue.Properties).toMatchObject({
        QueueName: `membership-refresh-work-${stage}-v1`,
        VisibilityTimeout: 360,
        MessageRetentionPeriod: 345600,
        ReceiveMessageWaitTimeSeconds: 20,
        SqsManagedSseEnabled: true,
        RedrivePolicy: {
          deadLetterTargetArn: { 'Fn::GetAtt': ['MembershipWorkDlq', 'Arn'] },
          maxReceiveCount: 5
        }
      });
      expect(resources.MembershipWorkDlq.Properties).toMatchObject({
        MessageRetentionPeriod: 1209600,
        SqsManagedSseEnabled: true,
        RedriveAllowPolicy: {
          redrivePermission: 'byQueue',
          sourceQueueArns: [
            {
              'Fn::Sub': `arn:\${AWS::Partition}:sqs:\${AWS::Region}:\${AWS::AccountId}:membership-refresh-work-${stage}-v1`
            }
          ]
        }
      });
      expect(template.Outputs.WorkQueueArn).toEqual({
        Value: { 'Fn::GetAtt': ['MembershipWorkQueue', 'Arn'] },
        Export: { Name: `membershipRefreshLoop-${stage}-WorkQueueArn-v1` }
      });
      expect(template.Outputs.WorkQueueUrl).toEqual({
        Value: { Ref: 'MembershipWorkQueue' },
        Export: { Name: `membershipRefreshLoop-${stage}-WorkQueueUrl-v1` }
      });
      expect(
        Object.values(resources).filter((r) => r.Type === 'AWS::IAM::Role')
      ).toHaveLength(1);
      const policies = resources.MembershipWorkerRole.Properties.Policies as {
        PolicyDocument: {
          Statement: { Action: string | string[]; Resource: unknown }[];
        };
      }[];
      const statements = policies.flatMap((p) => p.PolicyDocument.Statement);
      const actions = statements.flatMap((s) => s.Action);
      expect(actions).toEqual([
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSubnets',
        'ec2:DeleteNetworkInterface',
        'ec2:AssignPrivateIpAddresses',
        'ec2:UnassignPrivateIpAddresses',
        'secretsmanager:GetSecretValue',
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes'
      ]);
      expect(statements.filter((s) => s.Resource === '*')).toHaveLength(1);
      expect(
        statements.find((s) => s.Action === 'secretsmanager:GetSecretValue')
          ?.Resource
      ).toBe(
        stage === 'staging'
          ? 'arn:aws:secretsmanager:eu-west-1:987989283142:secret:prod/lambdas-qCUPVF'
          : 'arn:aws:secretsmanager:us-east-1:987989283142:secret:prod/lambdas-ZDzF7a'
      );
      const alarms = Object.values(resources).filter(
        (r) => r.Type === 'AWS::CloudWatch::Alarm'
      );
      expect(alarms).toHaveLength(5);
      for (const alarm of alarms)
        expect(alarm.Properties).toMatchObject({
          TreatMissingData: 'notBreaching',
          AlarmActions: [
            stage === 'staging'
              ? 'arn:aws:sns:eu-west-1:987989283142:cloudwatch-alarms'
              : 'arn:aws:sns:us-east-1:987989283142:cloudwatch-alarms'
          ]
        });
      expect(
        Object.values(resources).some((r) =>
          [
            'AWS::Lambda::Url',
            'AWS::Events::Rule',
            'AWS::ApiGateway::RestApi'
          ].includes(r.Type)
        )
      ).toBe(false);
    }
  );
});
