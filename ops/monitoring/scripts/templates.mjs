import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = new URL('../', import.meta.url);
const catalog = JSON.parse(
  await readFile(new URL('../../src/config/deploy-services.json', base), 'utf8')
);
const ref = (name) => ({ Ref: name });
const supplemental = JSON.parse(
  await readFile(new URL('platform-functions.json', base), 'utf8')
);
const attr = (name, property = 'Arn') => ({ 'Fn::GetAtt': [name, property] });
const sub = (value) => ({ 'Fn::Sub': value });
const when = (condition, yes, no = ref('AWS::NoValue')) => ({
  'Fn::If': [condition, yes, no]
});
const statement = (actions, resources, extra = {}) => ({
  Effect: 'Allow',
  Action: actions,
  Resource: resources,
  ...extra
});
const policy = (statements) => ({
  Version: '2012-10-17',
  Statement: statements
});
const parameter = (extra = {}) => ({ Type: 'String', ...extra });
// DynamoDB transactions authorize the underlying item operations.
const tableActions = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem'
];
const sqsConsume = [
  'sqs:ReceiveMessage',
  'sqs:DeleteMessage',
  'sqs:GetQueueAttributes',
  'sqs:ChangeMessageVisibility'
];
const document = (description) => ({
  AWSTemplateFormatVersion: '2010-09-09',
  Transform: 'AWS::Serverless-2016-10-31',
  Description: description,
  Parameters: {},
  Conditions: {},
  Resources: {},
  Outputs: {}
});
const environmentParameter = parameter({ AllowedValues: ['prod', 'staging'] });

function functionResource(
  handler,
  variables,
  statements,
  events = {},
  extra = {}
) {
  return {
    Type: 'AWS::Serverless::Function',
    Properties: {
      CodeUri: 'dist/',
      Handler: `handlers.${handler}`,
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 30,
      PermissionsBoundary: ref('RuntimePermissionsBoundaryArn'),
      Environment: { Variables: variables },
      Policies: [policy(statements)],
      Events: events,
      ...extra
    }
  };
}
function lambdaAlarm(resources, id, functionId, topic, metric = 'Errors') {
  resources[id] = {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      Namespace: 'AWS/Lambda',
      MetricName: metric,
      Dimensions: [{ Name: 'FunctionName', Value: ref(functionId) }],
      Statistic: 'Sum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [topic]
    }
  };
}
function monitoringTemplate(environment) {
  const functions = catalog.services
    .filter((s) => s.allowed_environments.includes(environment))
    .flatMap((s) => s.verification_targets);
  const doc = document(
    'Independent operational error delivery; deploy in the monitoring account.'
  );
  doc.Parameters = {
    Environment: {
      ...environmentParameter,
      AllowedValues: [environment],
      Default: environment
    },
    SourceAccountId: parameter({ AllowedPattern: '^\\d{12}$' }),
    SourceRegion: parameter({ AllowedPattern: '^[a-z]{2}(-gov)?-[a-z]+-\\d$' }),
    RuntimePermissionsBoundaryArn: parameter({
      AllowedPattern:
        '^arn:[^:]+:iam::[0-9]{12}:policy/6529-observability-(prod|staging)-runtime-boundary$'
    }),
    WebhookSecretArn: parameter({
      AllowedPattern: '^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$'
    }),
    SentrySecretArn: parameter({
      AllowedPattern: '^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$'
    }),
    SentryProjects: parameter({
      Default: '',
      Description: 'Comma-separated Sentry project slugs.'
    }),
    ExternalCheckInSecretArn: parameter({ Default: '' }),
    FallbackTargetTopicArn: parameter({
      Default: '',
      Description:
        'Optional confirmed source SNS topic; its policy must permit the fallback forwarder.'
    }),
    ProbeTargets: parameter({
      Default: '[]',
      Description:
        'JSON array of operator-approved public HTTPS targets: name, url, status.'
    })
  };
  doc.Conditions = {
    HasCheckIn: {
      'Fn::Not': [{ 'Fn::Equals': [ref('ExternalCheckInSecretArn'), ''] }]
    },
    HasFallbackTarget: {
      'Fn::Not': [{ 'Fn::Equals': [ref('FallbackTargetTopicArn'), ''] }]
    }
  };
  const r = doc.Resources;
  r.Receipts = {
    Type: 'AWS::DynamoDB::Table',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      SSESpecification: { SSEEnabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }
    }
  };
  r.Archive = {
    Type: 'AWS::S3::Bucket',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }
        ]
      },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'SanitizedRetention',
            Status: 'Enabled',
            ExpirationInDays: 365,
            NoncurrentVersionExpiration: { NoncurrentDays: 365 }
          }
        ]
      }
    }
  };
  r.ArchivePolicy = {
    Type: 'AWS::S3::BucketPolicy',
    Properties: {
      Bucket: ref('Archive'),
      PolicyDocument: policy([
        {
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [attr('Archive'), sub('${Archive.Arn}/*')],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } }
        }
      ])
    }
  };
  r.FallbackTopic = {
    Type: 'AWS::SNS::Topic',
    Properties: { DisplayName: '6529 independent monitoring fallback' }
  };
  for (const lane of ['Normal', 'Critical']) {
    r[`${lane}DeadLetters`] = {
      Type: 'AWS::SQS::Queue',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        MessageRetentionPeriod: 1209600,
        VisibilityTimeout: 180,
        SqsManagedSseEnabled: true,
        RedriveAllowPolicy: {
          redrivePermission: 'byQueue',
          sourceQueueArns: [
            sub(
              'arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:seize-monitoring-${Environment}-' +
                lane.toLowerCase()
            )
          ]
        }
      }
    };
    r[`${lane}Queue`] = {
      Type: 'AWS::SQS::Queue',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        QueueName: sub('seize-monitoring-${Environment}-' + lane.toLowerCase()),
        MessageRetentionPeriod: 1209600,
        VisibilityTimeout: 180,
        SqsManagedSseEnabled: true,
        RedrivePolicy: {
          deadLetterTargetArn: attr(`${lane}DeadLetters`),
          maxReceiveCount: lane === 'Normal' ? 40 : 8
        }
      }
    };
  }
  r.EventDeadLetters = {
    Type: 'AWS::SQS::Queue',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 180
    }
  };
  r.EventBus = {
    Type: 'AWS::Events::EventBus',
    Properties: { Name: sub('seize-monitoring-${Environment}-events') }
  };
  for (const [name, role, source] of [
    ['Application', 'logs', '6529.ops'],
    ['Platform', 'alarms-forward', 'aws.cloudwatch']
  ]) {
    r[`${name}BusPolicy`] = {
      Type: 'AWS::Events::EventBusPolicy',
      Properties: {
        EventBusName: ref('EventBus'),
        StatementId: `${name}Source`,
        Statement: {
          Effect: 'Allow',
          Principal: {
            AWS: sub('arn:${AWS::Partition}:iam::${SourceAccountId}:root')
          },
          Action: 'events:PutEvents',
          Resource: attr('EventBus'),
          Condition: {
            ArnEquals: {
              'aws:PrincipalArn': sub(
                'arn:${AWS::Partition}:iam::${SourceAccountId}:role/seize-monitoring-${Environment}-' +
                  role
              )
            },
            StringEquals: { 'events:source': source }
          }
        }
      }
    };
  }
  const common = {
    ENVIRONMENT: ref('Environment'),
    RECEIPTS_TABLE: ref('Receipts'),
    NORMAL_QUEUE_URL: ref('NormalQueue'),
    CRITICAL_QUEUE_URL: ref('CriticalQueue'),
    ARCHIVE_BUCKET: ref('Archive'),
    FALLBACK_TOPIC_ARN: ref('FallbackTopic')
  };
  const db = statement(tableActions, attr('Receipts'));
  const archiveWrite = statement(['s3:PutObject'], sub('${Archive.Arn}/*'));
  const publish = statement(['sns:Publish'], ref('FallbackTopic'));
  const sendNormal = statement(['sqs:SendMessage'], attr('NormalQueue'));
  const sendCritical = statement(['sqs:SendMessage'], attr('CriticalQueue'));
  const getWebhook = statement(
    ['secretsmanager:GetSecretValue'],
    ref('WebhookSecretArn')
  );
  const collectorEnv = {
    ...common,
    SOURCE_ACCOUNTS: ref('SourceAccountId'),
    SOURCE_REGION: ref('SourceRegion'),
    ALLOWED_SERVICES: functions.join(','),
    EVENTS_PER_SERVICE_MINUTE: '120'
  };
  for (const lane of ['Normal', 'Critical']) {
    const normal = lane === 'Normal';
    r[`${lane}Collector`] = functionResource(
      'collect',
      collectorEnv,
      normal ? [db, archiveWrite, sendNormal] : [sendCritical],
      {},
      { ReservedConcurrentExecutions: normal ? 4 : 2 }
    );
    r[`${lane}Rule`] = {
      Type: 'AWS::Events::Rule',
      Properties: {
        EventBusName: ref('EventBus'),
        EventPattern: {
          account: [ref('SourceAccountId')],
          source: [normal ? '6529.ops' : 'aws.cloudwatch'],
          ...(normal ? {} : { region: [ref('SourceRegion')] }),
          'detail-type': [
            normal ? '6529.ops.error.v1' : 'CloudWatch Alarm State Change'
          ]
        },
        Targets: [
          {
            Id: lane,
            Arn: attr(`${lane}Collector`),
            DeadLetterConfig: { Arn: attr('EventDeadLetters') },
            RetryPolicy: {
              MaximumEventAgeInSeconds: 86400,
              MaximumRetryAttempts: 185
            }
          }
        ]
      }
    };
    r[`${lane}Invocation`] = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        Action: 'lambda:InvokeFunction',
        FunctionName: ref(`${lane}Collector`),
        Principal: 'events.amazonaws.com',
        SourceArn: attr(`${lane}Rule`)
      }
    };
    // Lambda's own asynchronous retries are a separate boundary from EventBridge invocation retries.
    r[`${lane}CollectorInvokeConfig`] = {
      Type: 'AWS::Lambda::EventInvokeConfig',
      Properties: {
        FunctionName: ref(`${lane}Collector`),
        Qualifier: '$LATEST',
        MaximumEventAgeInSeconds: 21600,
        MaximumRetryAttempts: 2,
        DestinationConfig: {
          OnFailure: { Destination: attr('EventDeadLetters') }
        }
      }
    };
    r[`${lane}Collector`].Properties.Policies[0].Statement.push(
      statement(['sqs:SendMessage'], attr('EventDeadLetters'))
    );
    r[`${lane}Dispatcher`] = functionResource(
      'dispatch',
      {
        ...common,
        LANE: lane.toLowerCase(),
        WEBHOOK_SECRET_ARN: ref('WebhookSecretArn')
      },
      [
        db,
        archiveWrite,
        publish,
        getWebhook,
        ...(normal ? [sendNormal] : []),
        statement(sqsConsume, attr(`${lane}Queue`))
      ],
      {
        Queue: {
          Type: 'SQS',
          Properties: {
            Queue: attr(`${lane}Queue`),
            BatchSize: 1,
            FunctionResponseTypes: ['ReportBatchItemFailures'],
            ScalingConfig: { MaximumConcurrency: 2 }
          }
        }
      },
      { ReservedConcurrentExecutions: 3 }
    );
    for (const suffix of ['Collector', 'Dispatcher'])
      lambdaAlarm(
        r,
        `${lane}${suffix}Errors`,
        `${lane}${suffix}`,
        ref('FallbackTopic')
      );
    r[`${lane}QueueAge`] = {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateAgeOfOldestMessage',
        Dimensions: [
          { Name: 'QueueName', Value: attr(`${lane}Queue`, 'QueueName') }
        ],
        Statistic: 'Maximum',
        Period: 60,
        EvaluationPeriods: 2,
        Threshold: normal ? 600 : 120,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [ref('FallbackTopic')]
      }
    };
    r[`${lane}HeartbeatAge`] = {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: '6529/OperationalMonitoring',
        MetricName: 'HeartbeatAge',
        Dimensions: [
          { Name: 'Environment', Value: ref('Environment') },
          { Name: 'Lane', Value: lane.toLowerCase() }
        ],
        Statistic: 'Maximum',
        Period: 60,
        EvaluationPeriods: 3,
        Threshold: 180,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'breaching',
        AlarmActions: [ref('FallbackTopic')]
      }
    };
  }
  r.EventDeadLettersPolicy = {
    Type: 'AWS::SQS::QueuePolicy',
    Properties: {
      Queues: [ref('EventDeadLetters')],
      PolicyDocument: policy([
        {
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: attr('EventDeadLetters'),
          Condition: {
            ArnEquals: {
              'aws:SourceArn': [attr('NormalRule'), attr('CriticalRule')]
            }
          }
        }
      ])
    }
  };
  r.Archiver = functionResource(
    'archiveDeadLetters',
    common,
    [
      archiveWrite,
      publish,
      statement(sqsConsume, [
        attr('NormalDeadLetters'),
        attr('CriticalDeadLetters'),
        attr('EventDeadLetters')
      ])
    ],
    Object.fromEntries(
      ['NormalDeadLetters', 'CriticalDeadLetters', 'EventDeadLetters'].map(
        (name) => [
          name,
          {
            Type: 'SQS',
            Properties: {
              Queue: attr(name),
              BatchSize: 1,
              FunctionResponseTypes: ['ReportBatchItemFailures']
            }
          }
        ]
      )
    ),
    { ReservedConcurrentExecutions: 3 }
  );
  r.HttpApi = {
    Type: 'AWS::Serverless::HttpApi',
    Properties: {
      StageName: '$default',
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 20,
        ThrottlingRateLimit: 10
      }
    }
  };
  r.SentryIngress = functionResource(
    'ingress',
    {
      ...common,
      SENTRY_SECRET_ARN: ref('SentrySecretArn'),
      SENTRY_PROJECTS: ref('SentryProjects')
    },
    [
      db,
      archiveWrite,
      sendNormal,
      statement(['secretsmanager:GetSecretValue'], ref('SentrySecretArn'))
    ],
    {
      Sentry: {
        Type: 'HttpApi',
        Properties: { ApiId: ref('HttpApi'), Path: '/sentry', Method: 'POST' }
      }
    },
    { ReservedConcurrentExecutions: 3 }
  );
  r.Health = functionResource(
    'health',
    { RECEIPTS_TABLE: ref('Receipts') },
    [statement(['dynamodb:GetItem'], attr('Receipts'))],
    {
      Health: {
        Type: 'HttpApi',
        Properties: { ApiId: ref('HttpApi'), Path: '/health', Method: 'GET' }
      }
    },
    { ReservedConcurrentExecutions: 2 }
  );
  r.Probe = functionResource(
    'probe',
    {
      ...common,
      PROBE_TARGETS: ref('ProbeTargets'),
      WEBHOOK_SECRET_ARN: ref('WebhookSecretArn'),
      CHECKIN_SECRET_ARN: ref('ExternalCheckInSecretArn')
    },
    [
      db,
      sendNormal,
      sendCritical,
      getWebhook,
      when(
        'HasCheckIn',
        statement(
          ['secretsmanager:GetSecretValue'],
          ref('ExternalCheckInSecretArn')
        )
      ),
      statement(['cloudwatch:PutMetricData'], '*', {
        Condition: {
          StringEquals: { 'cloudwatch:namespace': '6529/OperationalMonitoring' }
        }
      })
    ],
    {
      Schedule: {
        Type: 'Schedule',
        Properties: { Schedule: 'rate(1 minute)', Enabled: true }
      }
    },
    { ReservedConcurrentExecutions: 1, Timeout: 90 }
  );
  r.FallbackForwarder = {
    ...functionResource(
      'forwardFallback',
      { FALLBACK_TARGET_TOPIC_ARN: ref('FallbackTargetTopicArn') },
      [statement(['sns:Publish'], ref('FallbackTargetTopicArn'))],
      { Topic: { Type: 'SNS', Properties: { Topic: ref('FallbackTopic') } } },
      { ReservedConcurrentExecutions: 1 }
    ),
    Condition: 'HasFallbackTarget'
  };
  for (const fn of ['Archiver', 'SentryIngress', 'Health', 'Probe'])
    lambdaAlarm(r, `${fn}Errors`, fn, ref('FallbackTopic'));
  for (const queue of [
    'NormalDeadLetters',
    'CriticalDeadLetters',
    'EventDeadLetters'
  ]) {
    r[`${queue}Alarm`] = {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Dimensions: [{ Name: 'QueueName', Value: attr(queue, 'QueueName') }],
        Statistic: 'Maximum',
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [ref('FallbackTopic')]
      }
    };
  }
  for (const metric of ['AdmissionOverflow', 'DeliveryFailures']) {
    r[`${metric}Alarm`] = {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: '6529/OperationalMonitoring',
        MetricName: metric,
        Dimensions: [{ Name: 'Environment', Value: ref('Environment') }],
        Statistic: 'Sum',
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [ref('FallbackTopic')]
      }
    };
  }
  for (const [id, resource] of Object.entries(r)) {
    if (resource.Type === 'AWS::Serverless::Function') {
      r[`${id}Logs`] = {
        Type: 'AWS::Logs::LogGroup',
        ...(resource.Condition ? { Condition: resource.Condition } : {}),
        Properties: {
          LogGroupName: sub('/aws/lambda/${' + id + '}'),
          RetentionInDays: 30
        }
      };
    }
  }
  doc.Outputs = {
    EventBusArn: { Value: attr('EventBus') },
    IngressUrl: {
      Value: sub(
        'https://${HttpApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}'
      )
    },
    FallbackTopicArn: { Value: ref('FallbackTopic') },
    ArchiveBucket: { Value: ref('Archive') },
    FallbackForwarderRoleArn: {
      Condition: 'HasFallbackTarget',
      Value: attr('FallbackForwarderRole')
    }
  };
  return doc;
}

function sourceTemplate(environment) {
  const services = catalog.services.filter((service) =>
    service.allowed_environments.includes(environment)
  );
  const functions = services.flatMap((service) => service.verification_targets);
  const platformOnly = supplemental.functions.filter((item) =>
    item.environments.includes(environment)
  );
  const platformFunctions = [
    ...functions,
    ...platformOnly.map((item) => item.name)
  ];
  if (
    new Set(platformFunctions).size !== platformFunctions.length ||
    platformFunctions.some((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
  ) {
    throw new Error('Invalid or duplicate platform function inventory');
  }
  const doc = document(
    'Application-account log relay and Lambda platform alarms. Preserve existing alarm email subscriptions.'
  );
  doc.Parameters = {
    Environment: {
      ...environmentParameter,
      AllowedValues: [environment],
      Default: environment
    },
    MonitoringEventBusArn: parameter({
      AllowedPattern: '^arn:[^:]+:events:[^:]+:[0-9]{12}:event-bus/.+$'
    }),
    ExistingAlarmTopicArn: parameter({ Default: '' })
  };
  doc.Conditions = {
    HasAlarmTopic: {
      'Fn::Not': [{ 'Fn::Equals': [ref('ExistingAlarmTopicArn'), ''] }]
    }
  };
  const r = doc.Resources;
  r.RelayDeadLetters = {
    Type: 'AWS::SQS::Queue',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true
    }
  };
  r.LogRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: sub('seize-monitoring-${Environment}-logs'),
      AssumeRolePolicyDocument: policy([
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole'
        }
      ]),
      Policies: [
        {
          PolicyName: 'Relay',
          PolicyDocument: policy([
            statement(
              ['logs:CreateLogStream', 'logs:PutLogEvents'],
              sub(
                'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/seize-monitoring-${Environment}-logs:*'
              )
            ),
            statement(['events:PutEvents'], ref('MonitoringEventBusArn')),
            statement(['sqs:SendMessage'], attr('RelayDeadLetters'))
          ])
        }
      ]
    }
  };
  r.LogRelay = {
    Type: 'AWS::Serverless::Function',
    Properties: {
      CodeUri: 'dist/',
      Handler: 'handlers.logs',
      Runtime: 'nodejs22.x',
      FunctionName: sub('seize-monitoring-${Environment}-logs'),
      Role: attr('LogRole'),
      Architectures: ['arm64'],
      Timeout: 60,
      MemorySize: 256,
      ReservedConcurrentExecutions: 5,
      DeadLetterQueue: { Type: 'SQS', TargetArn: attr('RelayDeadLetters') },
      Environment: {
        Variables: {
          SOURCE_ACCOUNT: ref('AWS::AccountId'),
          ENVIRONMENT: ref('Environment'),
          MONITOR_EVENT_BUS_ARN: ref('MonitoringEventBusArn'),
          ALLOWED_LOG_GROUPS: functions
            .map((name) => `/aws/lambda/${name}`)
            .join(',')
        }
      }
    }
  };
  r.LogRelayLogs = {
    Type: 'AWS::Logs::LogGroup',
    Properties: {
      LogGroupName: sub('/aws/lambda/seize-monitoring-${Environment}-logs'),
      RetentionInDays: 30
    }
  };
  r.LogPermission = {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      Action: 'lambda:InvokeFunction',
      FunctionName: ref('LogRelay'),
      Principal: sub('logs.${AWS::Region}.amazonaws.com'),
      SourceAccount: ref('AWS::AccountId'),
      SourceArn: sub(
        'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*:*'
      )
    }
  };
  r.AlarmForwardRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: sub('seize-monitoring-${Environment}-alarms-forward'),
      AssumeRolePolicyDocument: policy([
        {
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sts:AssumeRole',
          Condition: {
            StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') }
          }
        }
      ]),
      Policies: [
        {
          PolicyName: 'Forward',
          PolicyDocument: policy([
            statement(['events:PutEvents'], ref('MonitoringEventBusArn'))
          ])
        }
      ]
    }
  };
  r.AlarmForwardRule = {
    Type: 'AWS::Events::Rule',
    Properties: {
      EventPattern: {
        source: ['aws.cloudwatch'],
        'detail-type': ['CloudWatch Alarm State Change'],
        account: [ref('AWS::AccountId')]
      },
      Targets: [
        {
          Id: 'Monitoring',
          Arn: ref('MonitoringEventBusArn'),
          RoleArn: attr('AlarmForwardRole'),
          DeadLetterConfig: { Arn: attr('RelayDeadLetters') },
          RetryPolicy: {
            MaximumEventAgeInSeconds: 86400,
            MaximumRetryAttempts: 185
          }
        }
      ]
    }
  };
  r.RelayDeadLettersPolicy = {
    Type: 'AWS::SQS::QueuePolicy',
    Properties: {
      Queues: [ref('RelayDeadLetters')],
      PolicyDocument: policy([
        {
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: attr('RelayDeadLetters'),
          Condition: {
            ArnEquals: { 'aws:SourceArn': attr('AlarmForwardRule') }
          }
        }
      ])
    }
  };
  lambdaAlarm(
    r,
    'LogRelayErrors',
    'LogRelay',
    when('HasAlarmTopic', ref('ExistingAlarmTopicArn'))
  );
  for (const name of functions) {
    const id = name.replace(/[^a-zA-Z0-9]/g, '');
    r[`${id}ErrorLogs`] = {
      Type: 'AWS::Logs::SubscriptionFilter',
      DependsOn: ['LogPermission'],
      Properties: {
        DestinationArn: attr('LogRelay'),
        LogGroupName: `/aws/lambda/${name}`,
        FilterPattern: '"6529.ops.error.v1"'
      }
    };
  }
  for (const name of platformFunctions) {
    const id = name.replace(/[^a-zA-Z0-9]/g, '');
    for (const metric of ['Errors', 'Throttles']) {
      r[`${id}${metric}`] = {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: sub(
            'seize-monitoring-${Environment}-' + name + '-' + metric
          ),
          Namespace: 'AWS/Lambda',
          MetricName: metric,
          Dimensions: [{ Name: 'FunctionName', Value: name }],
          Statistic: 'Sum',
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
          AlarmActions: when(
            'HasAlarmTopic',
            [ref('ExistingAlarmTopicArn')],
            []
          )
        }
      };
    }
  }
  doc.Outputs = {
    LogRelayRoleArn: { Value: attr('LogRole') },
    AlarmForwardRoleArn: { Value: attr('AlarmForwardRole') }
  };
  return {
    doc,
    platformOnly: platformOnly.map((item) => ({
      name: item.name,
      owner: item.owner,
      coverage: ['lambda-errors', 'lambda-throttles'],
      deployCode: false
    })),
    coverage: services.map((service) => ({
      service: service.name,
      region: service.aws_region[environment],
      functions: service.verification_targets,
      coverage: service.verification_targets.length
        ? ['structured-error-logs', 'lambda-errors', 'lambda-throttles']
        : ['infrastructure-only-no-lambda']
    }))
  };
}

const outputs = {};
for (const environment of ['prod', 'staging']) {
  outputs[`monitoring-${environment}.json`] = monitoringTemplate(environment);
  const source = sourceTemplate(environment);
  outputs[`source-${environment}.json`] = source.doc;
  outputs[`coverage-${environment}.json`] = {
    environment,
    source: 'src/config/deploy-services.json',
    services: source.coverage,
    supplementalSource: 'ops/monitoring/platform-functions.json',
    platformOnly: source.platformOnly
  };
}
for (const [name, doc] of Object.entries(outputs)) {
  const path = new URL(name, base);
  const contents = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== contents)
      throw new Error(`Stale generated monitoring artifact: ${name}`);
  } else await writeFile(path, contents);
}
console.log(
  `Monitoring templates and coverage ${process.argv.includes('--check') ? 'verified' : 'generated'} in ${fileURLToPath(base).split(/[/\\]/).at(-2)}.`
);
