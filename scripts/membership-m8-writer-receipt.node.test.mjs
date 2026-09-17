import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argumentsForReceipt,
  requireDrainWindow,
  units,
  validateGithubRun,
  writerEvidence
} from './membership-m8-writer-receipt.mjs';

const sha = 'a'.repeat(40);
const codeSha256 = `${'zG'.repeat(21)}z=`;

function writer(functionName = 'xTdhLoop') {
  return {
    FunctionArn: `arn:aws:lambda:eu-west-1:987989283142:function:${functionName}`,
    State: 'Active',
    LastUpdateStatus: 'Successful',
    Runtime: 'nodejs22.x',
    Version: '$LATEST',
    Description: `${sha.slice(0, 9)} - reviewed deploy`,
    Environment: {
      Variables: {
        MEMBERSHIP_SOURCE_TRACKING_MODE: 'tracking-v1',
        MEMBERSHIP_SOURCE_TRACKING_STAGE: 'staging',
        MEMBERSHIP_DEPLOY_SOURCE_SHA: sha,
        GIT_COMMIT: sha
      }
    },
    LastModified: '2026-09-17T07:00:00.000+0000',
    Timeout: 900,
    CodeSha256: codeSha256
  };
}

test('requires exact ten deploy run IDs and a full source SHA', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'membership-m8-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'runs.json');
  const runs = Object.fromEntries(Object.keys(units).map((unit) => [unit, 7]));
  writeFileSync(path, JSON.stringify(runs));
  assert.deepEqual(
    argumentsForReceipt(['--expected-sha', sha, '--deploy-runs', path]),
    {
      sha,
      runs
    }
  );
  assert.throws(
    () =>
      argumentsForReceipt(['--expected-sha', 'short', '--deploy-runs', path]),
    /40 lowercase hex/
  );
  delete runs.api;
  writeFileSync(path, JSON.stringify(runs));
  assert.throws(
    () => argumentsForReceipt(['--expected-sha', sha, '--deploy-runs', path]),
    /exact ten writer units/
  );
  runs.api = 0;
  writeFileSync(path, JSON.stringify(runs));
  assert.throws(
    () => argumentsForReceipt(['--expected-sha', sha, '--deploy-runs', path]),
    /Invalid deploy run ID/
  );
});

test('binds the successful GitHub run to service, stage, path, ID and SHA', () => {
  const run = {
    id: 7,
    head_sha: sha,
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/deploy.yml',
    head_branch: '1a-staging',
    display_title: 'Deploy xTdhLoop to staging [manual]'
  };
  assert.doesNotThrow(() => validateGithubRun(run, 7, sha, 'xTdhLoop'));
  assert.doesNotThrow(() =>
    validateGithubRun(
      { ...run, display_title: 'Deploy xTdhLoop to staging' },
      7,
      sha,
      'xTdhLoop'
    )
  );
  for (const changed of [
    { id: 8 },
    { head_sha: 'b'.repeat(40) },
    { display_title: 'Deploy api to staging [manual]' },
    { path: '.github/workflows/other.yml' }
  ])
    assert.throws(
      () => validateGithubRun({ ...run, ...changed }, 7, sha, 'xTdhLoop'),
      /not a successful staging run/
    );
});

test('checks the deployed full commit and effective tracking configuration', () => {
  const evidence = writerEvidence(writer(), 'xTdhLoop', sha, 7);
  assert.equal(evidence.source_sha, sha);
  assert.equal(evidence.code_sha256, codeSha256);
  assert.equal(evidence.deploy_run_id, '7');
  assert.doesNotThrow(() =>
    writerEvidence(writer('seizeAPI'), 'seizeAPI', sha, 7)
  );
  for (const variables of [
    { MEMBERSHIP_DEPLOY_SOURCE_SHA: 'b'.repeat(40) },
    { MEMBERSHIP_SOURCE_TRACKING_MODE: 'inactive' },
    { MEMBERSHIP_SOURCE_TRACKING_STAGE: 'prod' }
  ]) {
    const configuration = writer();
    Object.assign(configuration.Environment.Variables, variables);
    assert.throws(
      () => writerEvidence(configuration, 'xTdhLoop', sha, 7),
      /reviewed tracked-writer configuration/
    );
  }
});

test('waits for the latest modification plus timeout and one minute', () => {
  const evidence = {
    xTdhLoop: { last_modified_millis: '1000', timeout_seconds: 900 },
    api: { last_modified_millis: '2000', timeout_seconds: 30 }
  };
  assert.throws(() => requireDrainWindow(evidence, 960999), /drain window/);
  assert.doesNotThrow(() => requireDrainWindow(evidence, 961000));
});
