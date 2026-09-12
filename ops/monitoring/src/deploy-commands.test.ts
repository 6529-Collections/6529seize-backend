import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cases = [
  { name: 'monitoring without fallback', source: false },
  { name: 'monitoring failed deploy', source: false, deployFails: true },
  { name: 'source failed deploy', source: true, deployFails: true },
  {
    name: 'monitoring failed protection',
    source: false,
    protectionFails: true
  },
  { name: 'source failed protection', source: true, protectionFails: true },
  {
    name: 'monitoring exact fallback grant',
    source: false,
    fallback: 'allowed'
  },
  {
    name: 'monitoring mismatched fallback grant',
    source: false,
    fallback: 'denied'
  },
  { name: 'source existing topic preserved', source: true },
  { name: 'source topic explicitly disabled', source: true, topic: '' },
  {
    name: 'source topic explicitly configured',
    source: true,
    topic: 'arn:aws:sns:us-east-1:111111111111:alarms'
  }
] as const;
for (const scenario of cases) {
  const source = scenario.source;
  test(`${scenario.name}: validates configuration and uploads oversized templates under its approved artifact prefix`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'monitoring-deploy-'));
    const executable = join(scratch, 'aws');
    writeFileSync(executable, 'mocked CLI fixture; never executed', {
      mode: 0o700,
      flag: 'wx'
    });
    const original = process.env;
    const monitorAccount = '222222222222';
    const sourceAccount = '111111111111';
    const sha = 'a'.repeat(40);
    const bucket = source ? 'source-test-artifacts' : 'monitor-test-artifacts';
    const fallback = 'fallback' in scenario ? scenario.fallback : undefined;
    const targetTopic = `arn:aws:sns:us-east-1:${sourceAccount}:alarms`;
    const parameters = {
      SourceAccountId: sourceAccount,
      SourceRegion: 'us-east-1',
      RuntimePermissionsBoundaryArn: `arn:aws:iam::${monitorAccount}:policy/6529-observability-prod-runtime-boundary`,
      FallbackKmsKeyArn: `arn:aws:kms:eu-west-1:${monitorAccount}:key/12345678-1234-1234-1234-123456789abc`,
      ...(fallback ? { FallbackTargetTopicArn: targetTopic } : {})
    };
    process.env = {
      ...original,
      AWS_CLI_PATH: executable,
      AWS_REGION: 'eu-west-1',
      MONITORING_ENVIRONMENT: 'prod',
      MONITORING_COMMIT_SHA: sha,
      MONITORING_ACCOUNT_ID: monitorAccount,
      SOURCE_ACCOUNT_ID: sourceAccount,
      MONITORING_ARTIFACT_BUCKET: bucket,
      SOURCE_ARTIFACT_BUCKET: bucket,
      MONITORING_CLOUDFORMATION_ROLE_ARN: `arn:aws:iam::${monitorAccount}:role/deploy`,
      MONITORING_EVENT_BUS_ARN: `arn:aws:events:eu-west-1:${monitorAccount}:event-bus/seize-monitoring-prod-events`,
      MONITORING_PARAMETERS: JSON.stringify(parameters),
      SOURCE_CLOUDFORMATION_ROLE_ARN: ''
    };
    if ('topic' in scenario)
      process.env.SOURCE_ALARM_TOPIC_ARN = scenario.topic;
    else delete process.env.SOURCE_ALARM_TOPIC_ARN;
    const coverage = JSON.parse(
      readFileSync(new URL('../coverage-prod.json', import.meta.url), 'utf8')
    );
    const functions = coverage.services.flatMap(
      (s: { functions: string[] }) => s.functions
    );
    const calls: string[][] = [];
    const subprocess = mock.method(
      childProcess,
      'spawnSync',
      (_file: string, args: string[]) => {
        calls.push(args);
        if ('deployFails' in scenario && args[1] === 'deploy')
          return { status: 1, stdout: '' };
        if (
          'protectionFails' in scenario &&
          args[1] === 'update-termination-protection'
        )
          return { status: 1, stdout: '' };
        let stdout = '';
        if (args[0] === 'sts') stdout = source ? sourceAccount : monitorAccount;
        if (args[1] === 'get-policy') stdout = 'v2';
        if (args[1] === 'get-policy-version')
          stdout = JSON.stringify({
            Statement: [
              {
                Effect: 'Allow',
                Action: ['sns:Publish'],
                Resource:
                  fallback === 'allowed' ? targetTopic : `${targetTopic}-other`
              }
            ]
          });
        if (args[0] === 'lambda')
          stdout = JSON.stringify([
            ...functions,
            ...coverage.platformOnly.map((p: { name: string }) => p.name)
          ]);
        if (args[1] === 'describe-log-groups')
          stdout = JSON.stringify(
            functions.map((name: string) => `/aws/lambda/${name}`)
          );
        if (args[1] === 'describe-subscription-filters') stdout = '[]';
        return { status: 0, stdout };
      }
    );
    syncBuiltinESMExports();
    try {
      const script = new URL(
        `../scripts/${source ? 'deploy-source' : 'deploy'}.mjs`,
        import.meta.url
      ).toString();
      const load = () =>
        import(`${script}?scenario=${encodeURIComponent(scenario.name)}`);
      if (fallback === 'denied') {
        await assert.rejects(load, /Fallback topic is not allowed/);
        assert.equal(
          calls.some((args) => args[0] === 'cloudformation'),
          false
        );
        return;
      }
      if ('deployFails' in scenario) {
        await assert.rejects(load, /AWS cloudformation deploy failed/);
        assert.equal(
          calls.some((args) => args[1] === 'update-termination-protection'),
          false
        );
        return;
      }
      if ('protectionFails' in scenario)
        await assert.rejects(
          load,
          /AWS cloudformation update-termination-protection failed/
        );
      else await load();
      const template = readFileSync(
        new URL(
          `../${source ? 'source' : 'monitoring'}-prod.json`,
          import.meta.url
        )
      );
      assert.ok(
        template.byteLength > 51200,
        'fixture must exercise the AWS inline-template limit'
      );
      const stackCommands = calls.filter(
        (args) => args[0] === 'cloudformation'
      );
      assert.equal(stackCommands.length, 3);
      assert.deepEqual(stackCommands[2], [
        'cloudformation',
        'update-termination-protection',
        '--enable-termination-protection',
        '--stack-name',
        `seize-monitoring-prod${source ? '-source' : ''}`,
        ...(source ? ['--region', 'us-east-1'] : [])
      ]);
      assert.equal(calls.at(-1), stackCommands[2]);
      const artifactCommands = stackCommands.slice(0, 2);
      assert.equal(artifactCommands.length, 2);
      for (const args of artifactCommands) {
        assert.equal(args[args.indexOf('--s3-bucket') + 1], bucket);
        assert.equal(
          args[args.indexOf('--s3-prefix') + 1],
          `${source ? 'monitoring-source/' : ''}prod/${sha}`
        );
      }
      assert.equal(artifactCommands[1]?.[1], 'deploy');
      const deployArgs = artifactCommands[1]!;
      if (source) {
        const topicArg = deployArgs.find((arg) =>
          arg.startsWith('ExistingAlarmTopicArn=')
        );
        assert.equal(
          topicArg,
          'topic' in scenario
            ? `ExistingAlarmTopicArn=${scenario.topic}`
            : undefined
        );
      } else {
        assert.ok(
          deployArgs.includes(
            `FallbackTargetTopicArn=${fallback ? targetTopic : ''}`
          )
        );
        if (fallback) {
          const reads = calls.filter((args) => args[0] === 'iam');
          assert.equal(reads.length, 2);
          for (const args of reads)
            assert.equal(
              args[args.indexOf('--policy-arn') + 1],
              parameters.RuntimePermissionsBoundaryArn
            );
        }
      }
    } finally {
      subprocess.mock.restore();
      syncBuiltinESMExports();
      process.env = original;
      unlinkSync(executable);
      rmdirSync(scratch);
    }
  });
}

test('captured AWS diagnostics distinguish CLI spawn failure and service denial without echoing arguments', async () => {
  const script = new URL('../scripts/aws-run.mjs', import.meta.url).toString();
  const { runAws } = await import(script);
  let spawnFailure = false;
  const subprocess = mock.method(childProcess, 'spawnSync', () =>
    spawnFailure
      ? {
          status: null,
          error: Object.assign(new Error('private executable path'), {
            code: 'ENOENT'
          })
        }
      : {
          status: 1,
          stderr: 'AccessDenied: metadata permission missing',
          stdout: ''
        }
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        runAws(
          'unused',
          ['iam', 'get-policy', '--policy-arn', 'argument-not-for-logs'],
          true
        ),
      (error: unknown) =>
        error instanceof Error &&
        /AWS iam get-policy failed: AccessDenied/.test(error.message) &&
        !error.message.includes('argument-not-for-logs')
    );
    spawnFailure = true;
    assert.throws(
      () => runAws('unused', ['sts', 'get-caller-identity'], true),
      /AWS sts get-caller-identity could not start \(ENOENT\)/
    );
  } finally {
    subprocess.mock.restore();
    syncBuiltinESMExports();
  }
});
