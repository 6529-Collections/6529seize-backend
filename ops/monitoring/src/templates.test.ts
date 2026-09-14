import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('catalog log subscriptions form one deterministic acyclic chain without changing their resource contract', () => {
  for (const env of ['prod', 'staging']) {
    const resources = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    ).Resources;
    const coverage = JSON.parse(
      readFileSync(new URL(`../coverage-${env}.json`, import.meta.url), 'utf8')
    );
    const subscriptions = coverage.services
      .flatMap((service: { functions: string[] }) => service.functions)
      .map((name: string) => ({
        name,
        id: `${name.replace(/[^a-zA-Z0-9]/g, '')}ErrorLogs`
      }))
      .sort((left: { id: string }, right: { id: string }) => {
        if (left.id === right.id) return 0;
        return left.id < right.id ? -1 : 1;
      });
    const actualIds = Object.keys(resources).filter(
      (id) => resources[id].Type === 'AWS::Logs::SubscriptionFilter'
    );
    assert.ok(subscriptions.length > 1);
    assert.equal(actualIds.length, subscriptions.length);
    assert.equal(
      new Set(subscriptions.map(({ id }: { id: string }) => id)).size,
      subscriptions.length
    );
    let previous: string | undefined;
    for (const { id, name } of subscriptions) {
      // Exactly one predecessor after the root proves a complete, acyclic chain.
      assert.deepEqual(
        resources[id],
        {
          Type: 'AWS::Logs::SubscriptionFilter',
          DependsOn: previous ? ['LogPermission', previous] : ['LogPermission'],
          Properties: {
            DestinationArn: { 'Fn::GetAtt': ['LogRelay', 'Arn'] },
            LogGroupName: `/aws/lambda/${name}`,
            FilterPattern: '"6529.ops.error.v1"'
          }
        },
        `${env}: ${id}`
      );
      previous = id;
    }
  }
});

test('NFT refresher throttling requires three breaching minutes out of five while failures remain immediate', () => {
  for (const env of ['prod', 'staging']) {
    const resources = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    ).Resources;
    const throttles = resources.nftLinkRefresherLoopThrottles.Properties;
    const errors = resources.nftLinkRefresherLoopErrors.Properties;
    assert.equal(throttles.Namespace, 'AWS/Lambda');
    assert.equal(throttles.MetricName, 'Throttles');
    assert.deepEqual(throttles.Dimensions, [
      { Name: 'FunctionName', Value: 'nftLinkRefresherLoop' }
    ]);
    assert.equal(throttles.Period, 60);
    assert.equal(throttles.EvaluationPeriods, 5);
    assert.equal(throttles.DatapointsToAlarm, 3);
    assert.equal(throttles.Threshold, 1);
    assert.equal(throttles.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
    assert.equal(throttles.TreatMissingData, 'notBreaching');
    assert.deepEqual(throttles.AlarmActions, {
      'Fn::If': ['HasAlarmTopic', [{ Ref: 'ExistingAlarmTopicArn' }], []]
    });
    assert.equal(errors.MetricName, 'Errors');
    assert.equal(errors.Period, 60);
    assert.equal(errors.EvaluationPeriods, 1);
    assert.equal(errors.Threshold, 1);
    assert.deepEqual(errors.AlarmActions, throttles.AlarmActions);

    // This exception must not weaken other services or monitoring itself.
    for (const [id, resource] of Object.entries(resources) as [
      string,
      { Type: string; Properties: Record<string, unknown> }
    ][]) {
      if (
        ![
          'nftLinkRefresherLoopThrottles',
          'waveScoreRefreshLoopThrottles',
          'subscriptionCoverageReconciliationLoopThrottles',
          'nftsLoopThrottles',
          'releaseNotesGenerationLoopThrottles'
        ].includes(id) &&
        resource.Type === 'AWS::CloudWatch::Alarm' &&
        resource.Properties.Namespace === 'AWS/Lambda'
      ) {
        assert.equal(resource.Properties.EvaluationPeriods, 1, id);
        assert.equal(resource.Properties.DatapointsToAlarm, undefined, id);
      }
    }
  }
});

test('overlapping scheduled workers qualify sustained throttles without delaying invocation failures or changing notification actions', () => {
  for (const env of ['prod', 'staging']) {
    const resources = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    ).Resources;
    for (const name of ['subscriptionCoverageReconciliationLoop', 'nftsLoop']) {
      const throttles = resources[`${name}Throttles`].Properties;
      const errors = resources[`${name}Errors`].Properties;
      assert.deepEqual(throttles, {
        AlarmName: {
          'Fn::Sub': `seize-monitoring-\${Environment}-${name}-Throttles`
        },
        Namespace: 'AWS/Lambda',
        MetricName: 'Throttles',
        Dimensions: [{ Name: 'FunctionName', Value: name }],
        Statistic: 'Sum',
        Period: 60,
        EvaluationPeriods: 5,
        DatapointsToAlarm: 3,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: {
          'Fn::If': ['HasAlarmTopic', [{ Ref: 'ExistingAlarmTopicArn' }], []]
        }
      });
      assert.equal(errors.MetricName, 'Errors');
      assert.equal(errors.EvaluationPeriods, 1);
      assert.equal(errors.DatapointsToAlarm, undefined);
      assert.equal(errors.Threshold, 1);
      assert.deepEqual(errors.AlarmActions, throttles.AlarmActions);
    }
    assert.equal(resources.LogRelayErrors.Properties.EvaluationPeriods, 1);
    assert.equal(
      resources.RelayDeadLettersAlarm.Properties.EvaluationPeriods,
      1
    );
  }
});

test('release-note throttles require sustained contention while errors stay immediate and direct email actions remain', () => {
  const prod = JSON.parse(
    readFileSync(new URL('../source-prod.json', import.meta.url), 'utf8')
  ).Resources;
  const stage = JSON.parse(
    readFileSync(new URL('../source-staging.json', import.meta.url), 'utf8')
  ).Resources;
  assert.equal(stage.releaseNotesGenerationLoopThrottles, undefined);
  const throttle = prod.releaseNotesGenerationLoopThrottles.Properties;
  assert.deepEqual(throttle, {
    AlarmName: {
      'Fn::Sub':
        'seize-monitoring-${Environment}-releaseNotesGenerationLoop-Throttles'
    },
    Namespace: 'AWS/Lambda',
    MetricName: 'Throttles',
    Dimensions: [{ Name: 'FunctionName', Value: 'releaseNotesGenerationLoop' }],
    Statistic: 'Sum',
    Period: 60,
    EvaluationPeriods: 5,
    DatapointsToAlarm: 3,
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    TreatMissingData: 'notBreaching',
    AlarmActions: {
      'Fn::If': ['HasAlarmTopic', [{ Ref: 'ExistingAlarmTopicArn' }], []]
    }
  });
  const error = prod.releaseNotesGenerationLoopErrors.Properties;
  assert.equal(error.MetricName, 'Errors');
  assert.equal(error.Period, 60);
  assert.equal(error.EvaluationPeriods, 1);
  assert.equal(error.DatapointsToAlarm, undefined);
  assert.equal(error.Threshold, 1);
  assert.deepEqual(error.AlarmActions, throttle.AlarmActions);
  assert.equal(prod.LogRelayErrors.Properties.EvaluationPeriods, 1);
  assert.equal(prod.RelayDeadLettersAlarm.Properties.EvaluationPeriods, 1);
});

test('wave throttling is sustained while queue backlog and dead letters have independent alarms', () => {
  for (const env of ['prod', 'staging']) {
    const resources = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    ).Resources;
    const throttles = resources.waveScoreRefreshLoopThrottles.Properties;
    assert.equal(throttles.EvaluationPeriods, 5);
    assert.equal(throttles.DatapointsToAlarm, 3);
    assert.equal(throttles.Period, 60);
    assert.equal(throttles.Threshold, 1);
    assert.equal(
      resources.waveScoreRefreshLoopErrors.Properties.EvaluationPeriods,
      1
    );
    for (const [id, queue] of [
      ['WaveScoreDirtyAge', 'wave-score-refresh-dirty.fifo'],
      ['WaveScoreStartAge', 'wave-score-refresh-start.fifo'],
      ['WaveScoreDirtyDeadLetters', 'wave-score-refresh-dirty-dlq.fifo']
    ]) {
      const alarm = resources[id!].Properties;
      const deadLetters = id === 'WaveScoreDirtyDeadLetters';
      assert.equal(alarm.Namespace, 'AWS/SQS');
      assert.deepEqual(alarm.Dimensions, [{ Name: 'QueueName', Value: queue }]);
      assert.equal(
        alarm.MetricName,
        deadLetters
          ? 'ApproximateNumberOfMessagesVisible'
          : 'ApproximateAgeOfOldestMessage'
      );
      assert.equal(alarm.Statistic, 'Maximum');
      assert.equal(alarm.Period, 60);
      assert.equal(alarm.Threshold, deadLetters ? 1 : 1800);
      assert.equal(alarm.EvaluationPeriods, deadLetters ? 1 : 5);
      assert.equal(alarm.DatapointsToAlarm, deadLetters ? undefined : 3);
      assert.equal(alarm.TreatMissingData, 'notBreaching');
      assert.deepEqual(alarm.AlarmActions, throttles.AlarmActions);
    }
    const worker = readFileSync(
      new URL(
        '../../../src/waveScoreRefreshLoop/serverless.yaml',
        import.meta.url
      ),
      'utf8'
    );
    assert.match(worker, /reservedConcurrency: 1\r?\n/);
    assert.doesNotMatch(worker, /maximumConcurrency:/);
    assert.match(worker, /MetricName: 'waveScoreRefreshLoop_OOMErrorCount'/);
  }
});

test('event-bus forwarding retains its local DLQ and failure alarm without unsupported retry settings', () => {
  for (const env of ['prod', 'staging']) {
    const source = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    ).Resources;
    const target = source.AlarmForwardRule.Properties.Targets[0];
    assert.deepEqual(target.Arn, { Ref: 'MonitoringEventBusArn' });
    assert.equal(Object.hasOwn(target, 'RetryPolicy'), false);
    assert.deepEqual(target.DeadLetterConfig.Arn, {
      'Fn::GetAtt': ['RelayDeadLetters', 'Arn']
    });
    assert.equal(source.RelayDeadLetters.DeletionPolicy, 'Retain');
    assert.equal(source.RelayDeadLetters.Properties.SqsManagedSseEnabled, true);
    assert.equal(
      source.RelayDeadLetters.Properties.MessageRetentionPeriod,
      1209600
    );
    const grant =
      source.RelayDeadLettersPolicy.Properties.PolicyDocument.Statement[0];
    assert.deepEqual(grant.Principal, { Service: 'events.amazonaws.com' });
    assert.equal(grant.Action, 'sqs:SendMessage');
    assert.deepEqual(grant.Resource, target.DeadLetterConfig.Arn);
    assert.deepEqual(grant.Condition.ArnEquals['aws:SourceArn'], {
      'Fn::GetAtt': ['AlarmForwardRule', 'Arn']
    });
    const alarm = source.RelayDeadLettersAlarm.Properties;
    assert.equal(alarm.Namespace, 'AWS/SQS');
    assert.equal(alarm.MetricName, 'ApproximateNumberOfMessagesVisible');
    assert.equal(alarm.Statistic, 'Maximum');
    assert.equal(alarm.Threshold, 1);
    assert.deepEqual(alarm.Dimensions, [
      {
        Name: 'QueueName',
        Value: { 'Fn::GetAtt': ['RelayDeadLetters', 'QueueName'] }
      }
    ]);
    assert.deepEqual(alarm.AlarmActions, {
      'Fn::If': ['HasAlarmTopic', [{ Ref: 'ExistingAlarmTopicArn' }], []]
    });
    const monitor = JSON.parse(
      readFileSync(
        new URL(`../monitoring-${env}.json`, import.meta.url),
        'utf8'
      )
    ).Resources;
    for (const lane of ['Normal', 'Critical']) {
      assert.deepEqual(
        monitor[`${lane}Rule`].Properties.Targets[0].RetryPolicy,
        {
          MaximumEventAgeInSeconds: 86400,
          MaximumRetryAttempts: 185
        }
      );
    }
  }
});

test('source catalog coverage is complete and monitoring delivery has no application runtime boundary', () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../src/config/deploy-services.json', import.meta.url),
      'utf8'
    )
  );
  for (const env of ['prod', 'staging']) {
    const monitor = JSON.parse(
      readFileSync(
        new URL(`../monitoring-${env}.json`, import.meta.url),
        'utf8'
      )
    );
    const source = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    );
    const boundary = new RegExp(
      monitor.Parameters.RuntimePermissionsBoundaryArn.AllowedPattern
    );
    assert.equal(
      boundary.test(
        `arn:aws:iam::111111111111:policy/6529-observability-${env}-runtime-boundary`
      ),
      true
    );
    assert.equal(
      boundary.test(
        `arn:aws:iam::111111111111:policy/6529-observability-${env === 'prod' ? 'staging' : 'prod'}-runtime-boundary`
      ),
      false
    );
    const coverage = JSON.parse(
      readFileSync(new URL(`../coverage-${env}.json`, import.meta.url), 'utf8')
    );
    const targets: string[] = catalog.services
      .filter((s: { allowed_environments: string[] }) =>
        s.allowed_environments.includes(env)
      )
      .flatMap(
        (s: { verification_targets: string[] }) => s.verification_targets
      );
    assert.deepEqual(
      coverage.services.flatMap((s: { functions: string[] }) => s.functions),
      targets
    );
    const filters = Object.values(source.Resources).filter(
      (r: unknown) =>
        (r as { Type: string }).Type === 'AWS::Logs::SubscriptionFilter'
    );
    assert.equal(filters.length, targets.length);
    for (const item of coverage.platformOnly as {
      name: string;
      deployCode: boolean;
    }[]) {
      const id = item.name.replace(/[^a-zA-Z0-9]/g, '');
      assert.equal(item.deployCode, false);
      assert.equal(source.Resources[`${id}ErrorLogs`], undefined);
      assert.ok(source.Resources[`${id}Errors`]);
      assert.ok(source.Resources[`${id}Throttles`]);
      assert.equal(targets.includes(item.name), false);
    }
    assert.notEqual(
      monitor.Resources.NormalDispatcher,
      monitor.Resources.CriticalDispatcher
    );
    assert.equal(
      monitor.Resources.NormalDispatcher.Properties
        .ReservedConcurrentExecutions,
      3
    );
    assert.equal(
      monitor.Resources.CriticalDispatcher.Properties
        .ReservedConcurrentExecutions,
      3
    );
    assert.equal(JSON.stringify(monitor).includes('VpcConfig'), false);
    assert.equal(JSON.stringify(monitor).includes('rds:'), false);
    assert.equal(JSON.stringify(monitor).includes('redis'), false);
    for (const resource of Object.values(monitor.Resources) as {
      Type: string;
      Properties: Record<string, unknown>;
    }[]) {
      if (resource.Type === 'AWS::Serverless::Function') {
        assert.equal(resource.Properties.CodeUri, 'dist/');
        assert.deepEqual(resource.Properties.PermissionsBoundary, {
          Ref: 'RuntimePermissionsBoundaryArn'
        });
      }
    }
  }
});

test('archive logging and encrypted fallback preserve narrowly scoped delivery permissions', () => {
  for (const env of ['prod', 'staging']) {
    const monitor = JSON.parse(
      readFileSync(
        new URL(`../monitoring-${env}.json`, import.meta.url),
        'utf8'
      )
    );
    const resources = monitor.Resources;
    assert.deepEqual(resources.FallbackTopic.Properties.KmsMasterKeyId, {
      Ref: 'FallbackKmsKeyArn'
    });
    assert.equal(
      Object.values(resources).some(
        (r: unknown) => (r as { Type: string }).Type === 'AWS::KMS::Key'
      ),
      false
    );
    for (const name of ['NormalDispatcher', 'CriticalDispatcher', 'Archiver']) {
      const statements = resources[name].Properties.Policies[0].Statement;
      const kms = statements.find((s: { Action: string[] }) =>
        s.Action.includes('kms:GenerateDataKey')
      );
      assert.deepEqual(kms.Resource, { Ref: 'FallbackKmsKeyArn' });
      assert.deepEqual(kms.Action, ['kms:GenerateDataKey', 'kms:Decrypt']);
      assert.deepEqual(kms.Condition.StringEquals['kms:ViaService'], {
        'Fn::Sub': 'sns.${AWS::Region}.${AWS::URLSuffix}'
      });
    }
    for (const name of [
      'NormalCollector',
      'CriticalCollector',
      'SentryIngress',
      'Health',
      'Probe'
    ]) {
      assert.equal(
        JSON.stringify(resources[name].Properties.Policies).includes('kms:'),
        false
      );
    }
    const alarmPublish =
      resources.FallbackTopicPolicy.Properties.PolicyDocument.Statement[0];
    assert.deepEqual(alarmPublish.Principal, {
      Service: 'cloudwatch.amazonaws.com'
    });
    assert.deepEqual(alarmPublish.Condition.StringEquals['aws:SourceAccount'], {
      Ref: 'AWS::AccountId'
    });
    assert.match(
      alarmPublish.Condition.ArnLike['aws:SourceArn']['Fn::Sub'],
      /alarm:seize-monitoring-\$\{Environment\}-\*/
    );
    assert.equal(resources.Archive.DependsOn, 'ArchiveAccessLogsPolicy');
    assert.deepEqual(
      resources.Archive.Properties.LoggingConfiguration.DestinationBucketName,
      { Ref: 'ArchiveAccessLogs' }
    );
    const logSink = resources.ArchiveAccessLogs;
    assert.equal(logSink.DeletionPolicy, 'Retain');
    assert.equal(logSink.Properties.VersioningConfiguration.Status, 'Enabled');
    assert.equal(logSink.Properties.LoggingConfiguration, undefined);
    assert.equal(
      logSink.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays,
      90
    );
    assert.equal(
      logSink.Properties.LifecycleConfiguration.Rules[0]
        .NoncurrentVersionExpiration.NoncurrentDays,
      90
    );
    const write =
      resources.ArchiveAccessLogsPolicy.Properties.PolicyDocument.Statement[0];
    assert.deepEqual(write.Principal, { Service: 'logging.s3.amazonaws.com' });
    assert.deepEqual(write.Condition.StringEquals['aws:SourceAccount'], {
      Ref: 'AWS::AccountId'
    });
    assert.equal(
      JSON.stringify(write.Condition.ArnEquals).includes('*'),
      false
    );
  }
});
