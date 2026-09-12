import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
