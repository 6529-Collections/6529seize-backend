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

for (const source of [false, true]) {
  test(`${source ? 'source' : 'monitoring'} deployment uploads oversized templates under its approved artifact prefix`, async () => {
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
    const parameters = {
      SourceAccountId: sourceAccount,
      SourceRegion: 'us-east-1',
      RuntimePermissionsBoundaryArn: `arn:aws:iam::${monitorAccount}:policy/6529-observability-prod-runtime-boundary`,
      FallbackKmsKeyArn: `arn:aws:kms:eu-west-1:${monitorAccount}:key/12345678-1234-1234-1234-123456789abc`
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
      SOURCE_CLOUDFORMATION_ROLE_ARN: '',
      SOURCE_ALARM_TOPIC_ARN: ''
    };
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
        let stdout = '';
        if (args[0] === 'sts') stdout = source ? sourceAccount : monitorAccount;
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
      await import(script);
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
      const artifactCommands = calls.filter(
        (args) => args[0] === 'cloudformation'
      );
      assert.equal(artifactCommands.length, 2);
      for (const args of artifactCommands) {
        assert.equal(args[args.indexOf('--s3-bucket') + 1], bucket);
        assert.equal(
          args[args.indexOf('--s3-prefix') + 1],
          `${source ? 'monitoring-source/' : ''}prod/${sha}`
        );
      }
      assert.equal(artifactCommands[1]?.[1], 'deploy');
    } finally {
      subprocess.mock.restore();
      syncBuiltinESMExports();
      process.env = original;
      unlinkSync(executable);
      rmdirSync(scratch);
    }
  });
}
