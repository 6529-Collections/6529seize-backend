import {
  assertRetirementChangeSet,
  removeMigratorMonitoring,
  RETIRED_MIGRATOR,
  retainMigratorRecoveryArtifacts,
  retirementChangeDiagnostics,
  retirementExecutionRole,
  Template
} from './infrastructure';

function monitor(): Template {
  return {
    Resources: {
      LogRelay: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Environment: {
            Variables: {
              ALLOWED_LOG_GROUPS: `/aws/lambda/other,/aws/lambda/${RETIRED_MIGRATOR}`,
              ALLOWED_SERVICES: `other,${RETIRED_MIGRATOR}`
            }
          },
          Role: 'shared-role',
          Code: { S3Key: 'current-code' }
        }
      },
      Previous: {
        Type: 'AWS::Logs::SubscriptionFilter',
        Properties: { DestinationArn: { 'Fn::GetAtt': ['LogRelay', 'Arn'] } }
      },
      competitionMigrationLoopErrorLogs: {
        Type: 'AWS::Logs::SubscriptionFilter',
        DependsOn: ['LogPermission', 'Previous'],
        Properties: { LogGroupName: `/aws/lambda/${RETIRED_MIGRATOR}` }
      },
      competitionMigrationLoopErrors: {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Dimensions: [{ Name: 'FunctionName', Value: RETIRED_MIGRATOR }]
        }
      },
      competitionMigrationLoopThrottles: {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Throttles',
          Dimensions: [{ Name: 'FunctionName', Value: RETIRED_MIGRATOR }]
        }
      },
      Following: {
        Type: 'AWS::Logs::SubscriptionFilter',
        DependsOn: ['LogPermission', `${RETIRED_MIGRATOR}ErrorLogs`],
        Properties: { LogGroupName: '/aws/lambda/live-native-worker' }
      },
      SharedRole: {
        Type: 'AWS::IAM::Role',
        Properties: { RoleName: 'shared-role', Policies: ['unchanged'] }
      }
    }
  };
}

it('removes exactly the retired producer registration and repairs only its subscription dependency', () => {
  const original = monitor();
  const edit = removeMigratorMonitoring(original);
  expect(edit.deleted).toHaveLength(3);
  expect(edit.modified.sort((a, b) => a.localeCompare(b))).toEqual([
    'Following',
    'LogRelay'
  ]);
  expect(edit.template.Resources.Following.DependsOn).toEqual([
    'LogPermission',
    'Previous'
  ]);
  expect(edit.template.Resources.SharedRole).toEqual(
    original.Resources.SharedRole
  );
  expect(edit.template.Resources.LogRelay.Properties?.Role).toBe('shared-role');
  expect(edit.template.Resources.LogRelay.Properties?.Code).toEqual({
    S3Key: 'current-code'
  });
  expect(JSON.stringify(edit.template)).not.toContain(RETIRED_MIGRATOR);
  expect(edit.reevaluated).toEqual(['Previous']);
  expect(Object.keys(original.Resources)).toHaveLength(7);
});

it('refuses unexpected references and resource ownership instead of deleting a shared target', () => {
  const original = monitor();
  original.Resources.competitionMigrationLoopErrors.Properties!.Dimensions = [
    { Name: 'FunctionName', Value: 'live-native-worker' }
  ];
  expect(() => removeMigratorMonitoring(original)).toThrow('ownership');
  const unknown = monitor();
  unknown.Resources.SharedRole.Properties!.PolicyArn = RETIRED_MIGRATOR;
  expect(() => removeMigratorMonitoring(unknown)).toThrow(
    'Unexpected remaining'
  );
});

it.each([
  { Action: 'Add', LogicalResourceId: 'LogRelay', Replacement: 'False' },
  { Action: 'Modify', LogicalResourceId: 'SharedRole', Replacement: 'False' },
  { Action: 'Modify', LogicalResourceId: 'LogRelay', Replacement: 'True' },
  { Action: 'Modify', LogicalResourceId: 'LogRelay' },
  { Action: 'Modify', LogicalResourceId: 'LogRelay', Replacement: null },
  {
    Action: 'Modify',
    LogicalResourceId: 'LogRelay',
    Replacement: 'Conditional'
  }
])('rejects unrelated or replacing CloudFormation changes %j', (change) => {
  const edit = removeMigratorMonitoring(monitor());
  expect(() =>
    assertRetirementChangeSet(edit, [{ ResourceChange: change }])
  ).toThrow();
});

it('accepts only the full deletion set and the reviewed environment/dependency updates', () => {
  const edit = removeMigratorMonitoring(monitor());
  const changes = [
    ...edit.deleted.map((id) => ({
      ResourceChange: { Action: 'Remove', LogicalResourceId: id }
    })),
    ...edit.modified.map((id) => ({
      ResourceChange: {
        Action: 'Modify',
        LogicalResourceId: id,
        Replacement: 'False'
      }
    }))
  ];
  expect(() => assertRetirementChangeSet(edit, changes)).not.toThrow();
  expect(() => assertRetirementChangeSet(edit, changes.slice(1))).toThrow(
    'complete reviewed'
  );
});

it('identifies rejected dependency changes without exposing property values', () => {
  const change = {
    Action: 'Modify',
    LogicalResourceId: 'UnexpectedSchedule',
    ResourceType: 'AWS::Events::Rule',
    Replacement: 'False',
    Scope: ['Properties'],
    BeforeContext: 'private-template-value',
    AfterContext: 'private-template-value',
    Details: [
      {
        Evaluation: 'Dynamic',
        ChangeSource: 'ResourceAttribute',
        CausingEntity: 'Collector.Arn',
        Target: {
          Attribute: 'Properties',
          Name: 'Targets',
          RequiresRecreation: 'Never',
          BeforeValue: 'private-template-value',
          AfterValue: 'private-template-value'
        }
      }
    ]
  };
  let message = '';
  try {
    assertRetirementChangeSet(removeMigratorMonitoring(monitor()), [
      { ResourceChange: change }
    ]);
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  expect(message).toContain('UnexpectedSchedule');
  expect(message).toContain('Collector.Arn');
  expect(message).toContain('Targets');
  expect(message).not.toContain('private-template-value');
  const diagnostics = retirementChangeDiagnostics([
    { ResourceChange: change },
    {
      ResourceChange: {
        ...change,
        LogicalResourceId: 'AnotherDependency'
      }
    },
    {}
  ]);
  expect(diagnostics).toHaveLength(3);
  expect(diagnostics[1]).toMatchObject({ id: 'AnotherDependency' });
  expect(diagnostics[2]).toEqual({ unreadable: true });
  expect(JSON.stringify(diagnostics)).not.toContain('private-template-value');
});

function subscriptionEvaluation() {
  return {
    Action: 'Modify',
    LogicalResourceId: 'Previous',
    ResourceType: 'AWS::Logs::SubscriptionFilter',
    Replacement: 'False',
    Scope: ['Properties'],
    Details: [
      {
        Target: {
          Attribute: 'Properties',
          Name: 'DestinationArn',
          RequiresRecreation: 'Never'
        },
        Evaluation: 'Dynamic',
        ChangeSource: 'ResourceAttribute',
        CausingEntity: 'LogRelay.Arn'
      }
    ]
  };
}

function evaluationChanges(change = subscriptionEvaluation()) {
  const edit = removeMigratorMonitoring(monitor());
  return {
    edit,
    changes: [
      ...edit.deleted.map((id) => ({
        ResourceChange: { Action: 'Remove', LogicalResourceId: id }
      })),
      {
        ResourceChange: {
          Action: 'Modify',
          LogicalResourceId: 'LogRelay',
          ResourceType: 'AWS::Lambda::Function',
          Replacement: 'False',
          Scope: ['Properties'],
          Details: [
            {
              Target: {
                Attribute: 'Properties',
                Name: 'Environment',
                RequiresRecreation: 'Never'
              },
              Evaluation: 'Static',
              ChangeSource: 'DirectModification'
            }
          ]
        }
      },
      { ResourceChange: change }
    ]
  };
}

it('accepts only exact dynamic ARN reevaluation of an unchanged relay subscription', () => {
  const { edit, changes } = evaluationChanges();
  expect(() => assertRetirementChangeSet(edit, changes)).not.toThrow();
  expect(edit.template.Resources.Previous).toEqual(
    monitor().Resources.Previous
  );
  const other = monitor();
  other.Resources.Previous.Properties!.DestinationArn = {
    'Fn::GetAtt': ['OtherRelay', 'Arn']
  };
  expect(removeMigratorMonitoring(other).reevaluated).toEqual([]);
});

it('requires the exact relay environment update causing the subscription reevaluation', () => {
  const { edit, changes } = evaluationChanges();
  expect(() =>
    assertRetirementChangeSet(
      edit,
      changes.filter(
        ({ ResourceChange: change }) => change.LogicalResourceId !== 'LogRelay'
      )
    )
  ).toThrow();
  const relay = changes.find(
    ({ ResourceChange: change }) => change.LogicalResourceId === 'LogRelay'
  )!;
  if (!('Details' in relay.ResourceChange))
    throw new Error('Expected the relay change test fixture');
  relay.ResourceChange.Details![0]!.Target!.Name = 'Code';
  expect(() => assertRetirementChangeSet(edit, changes)).toThrow();
});

it.each([
  { Replacement: undefined },
  { Replacement: null },
  { Replacement: 'True' },
  { Replacement: 'Conditional' },
  { ResourceType: 'AWS::IAM::Role' },
  { LogicalResourceId: 'SharedRole' },
  { Scope: ['Properties', 'Metadata'] },
  { Scope: undefined },
  { Details: [] },
  { Details: undefined }
])('rejects an unrelated subscription evaluation %j', (override) => {
  const { edit, changes } = evaluationChanges();
  Object.assign(changes.at(-1)!.ResourceChange!, override);
  expect(() => assertRetirementChangeSet(edit, changes)).toThrow();
});

it.each([
  { Evaluation: 'Static' },
  { ChangeSource: 'DirectModification' },
  { CausingEntity: 'OtherRelay.Arn' },
  {
    Target: {
      Attribute: 'Properties',
      Name: 'FilterPattern',
      RequiresRecreation: 'Never'
    }
  },
  {
    Target: {
      Attribute: 'Properties',
      Name: 'DestinationArn',
      RequiresRecreation: 'Always'
    }
  }
])('rejects a different dependent property evaluation %j', (override) => {
  const change = subscriptionEvaluation();
  Object.assign(change.Details[0], override);
  const { edit, changes } = evaluationChanges(change);
  expect(() => assertRetirementChangeSet(edit, changes)).toThrow();
});

it('does not accept a native worker stack as the retired migrator stack', () => {
  expect(() =>
    retainMigratorRecoveryArtifacts({
      Resources: {
        Native: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'waveDecisionExecutionLoop' }
        }
      }
    })
  ).toThrow('Unexpected resource');
});

function migrator(): Template {
  const fn = 'CompetitionMigrationLoopLambdaFunction';
  const arn = { 'Fn::GetAtt': [fn, 'Arn'] };
  const alarm = () => ({
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      Namespace: 'AWS/Lambda',
      Dimensions: [{ Name: 'FunctionName', Value: RETIRED_MIGRATOR }]
    }
  });
  return {
    Resources: {
      [fn]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: RETIRED_MIGRATOR,
          ReservedConcurrentExecutions: 0,
          Role: 'arn:aws:iam::987989283142:role/lambda-vpc-role'
        }
      },
      CompetitionMigrationLoopLambdaVersionFixture: {
        Type: 'AWS::Lambda::Version',
        Properties: { FunctionName: { Ref: fn } }
      },
      CompetitionMigrationLoopLambdaEvConf: {
        Type: 'AWS::Lambda::EventInvokeConfig',
        Properties: {
          FunctionName: { Ref: fn },
          MaximumEventAgeInSeconds: 60,
          MaximumRetryAttempts: 0
        }
      },
      CompetitionMigrationContinuationPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          Roles: ['lambda-vpc-role'],
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'lambda:InvokeFunction',
                Resource: [arn, { 'Fn::Join': [':', [arn, '*']] }]
              }
            ]
          }
        }
      },
      CompetitionMigrationFailureAlarm: alarm(),
      CompetitionMigrationDroppedContinuationAlarm: alarm(),
      CompetitionMigrationLoopLogGroup: {
        Type: 'AWS::Logs::LogGroup',
        Properties: { LogGroupName: `/aws/lambda/${RETIRED_MIGRATOR}` }
      },
      ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
      ServerlessDeploymentBucketPolicy: {
        Type: 'AWS::S3::BucketPolicy',
        Properties: { Bucket: { Ref: 'ServerlessDeploymentBucket' } }
      }
    }
  };
}

it('retains only the dedicated recovery bucket and policy before stack deletion', () => {
  const original = migrator();
  const edit = retainMigratorRecoveryArtifacts(original);
  expect(edit.deleted).toEqual([]);
  expect(edit.modified).toEqual([
    'ServerlessDeploymentBucket',
    'ServerlessDeploymentBucketPolicy'
  ]);
  expect(
    edit.template.Resources.ServerlessDeploymentBucket.DeletionPolicy
  ).toBe('Retain');
  expect(
    edit.template.Resources.CompetitionMigrationLoopLambdaFunction
  ).toEqual(original.Resources.CompetitionMigrationLoopLambdaFunction);
  expect(
    edit.template.Resources.CompetitionMigrationLoopLogGroup.DeletionPolicy
  ).toBeUndefined();
  expect(retainMigratorRecoveryArtifacts(edit.template).modified).toEqual([]);
});

it('refuses deletion of a shared role policy with permissions beyond the retired producer', () => {
  const original = migrator();
  original.Resources.CompetitionMigrationContinuationPolicy.Properties!.PolicyDocument =
    {
      Statement: [
        { Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: '*' }
      ]
    };
  expect(() => retainMigratorRecoveryArtifacts(original)).toThrow(
    'exclusively scoped'
  );
});

it.each(['source', 'migrator'])(
  'preserves the audited direct-caller boundary for %s',
  (kind) => {
    expect(retirementExecutionRole('prod', kind)).toBeUndefined();
    expect(() =>
      retirementExecutionRole(
        'prod',
        kind,
        'arn:aws:iam::987989283142:role/unexpected'
      )
    ).toThrow('without a role override');
    expect(() =>
      retirementExecutionRole(
        'prod',
        kind,
        undefined,
        'arn:aws:iam::987989283142:role/unexpected'
      )
    ).toThrow('without a role override');
  }
);
it('allows only the matching scoped monitoring role and never replaces an unexpected stack role', () => {
  const role =
    'arn:aws:iam::876382073372:role/6529-observability-prod-cfn-execution';
  expect(retirementExecutionRole('prod', 'monitoring', role)).toBe(role);
  expect(retirementExecutionRole('prod', 'monitoring', undefined, role)).toBe(
    role
  );
  expect(() => retirementExecutionRole('staging', 'monitoring', role)).toThrow(
    'Unexpected scoped'
  );
  expect(() =>
    retirementExecutionRole('prod', 'monitoring', 'unexpected', role)
  ).toThrow('Unexpected scoped');
});
