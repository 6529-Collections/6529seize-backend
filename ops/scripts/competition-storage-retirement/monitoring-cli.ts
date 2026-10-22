/** Live-template-only infrastructure maintenance using existing scoped identities. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseCloudFormationTemplate } from '../../monitoring/src/cloudformation-template.js';
import {
  assertRetirementChangeSet,
  removeMigratorMonitoring,
  retainMigratorRecoveryArtifacts,
  retirementExecutionRole,
  type Template,
  type TemplateEdit
} from './infrastructure';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = () => new Promise((done) => setTimeout(done, 5000));
type AwsCommand = <T>(args: string[]) => T;
interface Stack {
  StackId: string;
  StackStatus: string;
  LastUpdatedTime?: string;
  Parameters?: { ParameterKey: string }[];
  RoleARN?: string;
}
interface ChangeSet {
  ChangeSetId: string;
  Status: string;
  ExecutionStatus: string;
  Changes?: Parameters<typeof assertRetirementChangeSet>[1];
}
interface Options {
  environment: 'staging' | 'prod';
  kind: string;
  account: string;
  region: string;
  revision: string;
  stackName: string;
  output: string;
  apply: boolean;
  approvedPlanSha256?: string;
}

function options(): Options {
  const environment = process.env.MONITORING_ENVIRONMENT;
  const kind = process.env.RETIRE_STACK_KIND ?? 'monitoring';
  if (
    (environment !== 'staging' && environment !== 'prod') ||
    !['monitoring', 'source', 'migrator'].includes(kind)
  )
    throw new Error('Select the exact retirement environment and stack kind');
  const account = kind === 'monitoring' ? '876382073372' : '987989283142';
  const region =
    kind === 'monitoring' || environment === 'staging'
      ? 'eu-west-1'
      : 'us-east-1';
  const revision = process.env.MONITORING_COMMIT_SHA ?? '';
  const output = process.env.RETIRE_EVIDENCE_DIR;
  if (process.env.AWS_REGION !== region || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Unexpected retirement region or reviewed revision');
  if (!output || !isAbsolute(output))
    throw new Error('Select a private absolute evidence directory');
  const stackName =
    kind === 'migrator'
      ? `competitionMigrationLoop-${environment}`
      : `seize-monitoring-${environment}${kind === 'source' ? '-source' : ''}`;
  const apply = process.env.RETIRE_APPLY === 'true';
  const approvedPlanSha256 = process.env.RETIRE_APPROVED_PLAN_SHA256;
  if (apply && !/^[a-f0-9]{64}$/.test(approvedPlanSha256 ?? ''))
    throw new Error(
      'Apply requires the exact SHA-256 from the prior proposed retirement receipt'
    );
  return {
    environment,
    kind,
    account,
    region,
    revision,
    stackName,
    output,
    apply,
    approvedPlanSha256
  };
}

function approvedExecutable() {
  const candidate = process.env.AWS_CLI_PATH;
  if (!candidate || !isAbsolute(candidate))
    throw new Error('Select an approved absolute AWS CLI path');
  const aws = realpathSync(candidate);
  const fromRepo = relative(resolve(__dirname, '../../..'), aws);
  if (
    basename(aws) !== 'aws' ||
    !(
      fromRepo === '..' ||
      fromRepo.startsWith(`..${sep}`) ||
      isAbsolute(fromRepo)
    )
  )
    throw new Error(
      'AWS CLI must be the installed executable outside the checkout'
    );
  return aws;
}

function diagnostic(error: unknown): string {
  let message = (
    (error as { stderr?: Buffer | string }).stderr?.toString() ??
    'request failed'
  ).slice(0, 2000);
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN'
  ]) {
    const value = process.env[key];
    if (value) message = message.split(value).join('[redacted]');
  }
  return message;
}

function awsCommand(region: string): AwsCommand {
  const aws = approvedExecutable();
  return <T>(args: string[]): T => {
    try {
      const result = execFileSync(
        aws,
        [...args, '--region', region, '--output', 'json', '--no-cli-pager'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return (result.trim() ? JSON.parse(result) : {}) as T;
    } catch (error) {
      throw new Error(
        `AWS ${args.slice(0, 2).join(' ')} failed: ${diagnostic(error)}`
      );
    }
  };
}

function readStack(command: AwsCommand, name: string): Stack {
  return command<{ Stacks: Stack[] }>([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    name
  ]).Stacks[0];
}
function readTemplate(command: AwsCommand, name: string): Template {
  const result = command<{ TemplateBody: Template | string }>([
    'cloudformation',
    'get-template',
    '--stack-name',
    name,
    '--template-stage',
    'Original'
  ]);
  return parseCloudFormationTemplate(result.TemplateBody);
}
function save(output: string, name: string, value: unknown) {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx'
  });
}

async function awaitChangeSet(
  command: AwsCommand,
  id: string
): Promise<ChangeSet> {
  for (let attempt = 0; attempt < 36; attempt++) {
    const current = command<ChangeSet>([
      'cloudformation',
      'describe-change-set',
      '--change-set-name',
      id
    ]);
    if (
      current.Status === 'CREATE_COMPLETE' &&
      current.ExecutionStatus === 'AVAILABLE'
    )
      return current;
    if (current.Status === 'FAILED')
      throw new Error(
        'CloudFormation rejected the proposed retirement change set'
      );
    await pause();
  }
  throw new Error('Retirement change set did not become available');
}

function uploadTemplate(
  selected: Options,
  command: AwsCommand,
  edit: TemplateEdit
): string {
  const bucket = process.env.MONITORING_ARTIFACT_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error(
      'Select the existing private infrastructure artifact bucket'
    );
  const path = join(selected.output, 'desired-template.json');
  save(selected.output, 'desired-template.json', edit.template);
  const key = `${selected.environment}/${selected.revision}/competition-retirement-${digest(edit.template)}.json`;
  command([
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    key,
    '--body',
    path,
    '--expected-bucket-owner',
    selected.account,
    '--server-side-encryption',
    'AES256'
  ]);
  return `https://s3.${selected.region}.amazonaws.com/${bucket}/${key}`;
}

async function propose(
  selected: Options,
  command: AwsCommand,
  stack: Stack,
  edit: TemplateEdit,
  role: string | undefined
): Promise<ChangeSet> {
  const url = uploadTemplate(selected, command, edit);
  save(
    selected.output,
    'previous-parameters.json',
    (stack.Parameters ?? []).map(({ ParameterKey }) => ({
      ParameterKey,
      UsePreviousValue: true
    }))
  );
  const created = command<{ Id: string }>([
    'cloudformation',
    'create-change-set',
    '--stack-name',
    stack.StackId,
    '--change-set-name',
    `competition-retirement-${selected.kind}-${Date.now()}`,
    '--change-set-type',
    'UPDATE',
    '--template-url',
    url,
    '--capabilities',
    'CAPABILITY_NAMED_IAM',
    'CAPABILITY_AUTO_EXPAND',
    '--parameters',
    `file://${join(selected.output, 'previous-parameters.json')}`,
    ...(role ? ['--role-arn', role] : [])
  ]);
  if (!created.Id)
    throw new Error('CloudFormation did not identify the proposed change set');
  const changes = await awaitChangeSet(command, created.Id);
  save(selected.output, 'change-set.json', changes);
  assertRetirementChangeSet(edit, changes.Changes ?? []);
  return changes;
}

function assertUnmoved(
  selected: Options,
  command: AwsCommand,
  stack: Stack,
  original: Template
) {
  const current = readStack(command, selected.stackName);
  if (
    current.StackId !== stack.StackId ||
    current.StackStatus !== stack.StackStatus ||
    current.LastUpdatedTime !== stack.LastUpdatedTime ||
    digest(readTemplate(command, selected.stackName)) !== digest(original)
  )
    throw new Error(
      'Shared stack moved during review; preserve the other deployment and re-plan'
    );
}

async function awaitUpdate(
  selected: Options,
  command: AwsCommand,
  id: string,
  expected: string
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = readStack(command, selected.stackName).StackStatus;
    if (status.includes('FAILED') || status.includes('ROLLBACK'))
      throw new Error(
        'Retirement stack update failed; inspect CloudFormation without automatic retry'
      );
    if (status === 'UPDATE_COMPLETE') {
      const execution = command<ChangeSet>([
        'cloudformation',
        'describe-change-set',
        '--change-set-name',
        id
      ]);
      if (
        execution.ExecutionStatus === 'EXECUTE_COMPLETE' &&
        digest(readTemplate(command, selected.stackName)) === expected
      )
        return;
    }
    await pause();
  }
  throw new Error('Live retirement template did not match the reviewed update');
}

async function main() {
  const selected = options();
  const command = awsCommand(selected.region);
  if (
    command<{ Account: string }>(['sts', 'get-caller-identity']).Account !==
    selected.account
  )
    throw new Error('Wrong retirement AWS account');
  const stack = readStack(command, selected.stackName);
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus))
    throw new Error(
      'Another stack operation is active or requires attention; wait without cancelling it'
    );
  const role = retirementExecutionRole(
    selected.environment,
    selected.kind,
    stack.RoleARN,
    process.env.MONITORING_CLOUDFORMATION_ROLE_ARN
  );
  const original = readTemplate(command, selected.stackName);
  const edit =
    selected.kind === 'migrator'
      ? retainMigratorRecoveryArtifacts(original)
      : removeMigratorMonitoring(original);
  mkdirSync(selected.output, { recursive: true, mode: 0o700 });
  const plan = {
    environment: selected.environment,
    kind: selected.kind,
    account: selected.account,
    region: selected.region,
    revision: selected.revision,
    stackName: selected.stackName,
    originalDigest: digest(original),
    desiredDigest: digest(edit.template),
    deleted: edit.deleted,
    modified: edit.modified,
    reevaluated: edit.reevaluated ?? []
  };
  const summary = { ...plan, planSha256: digest(plan) };
  save(selected.output, 'template-plan.json', {
    ...summary,
    original,
    desired: edit.template
  });
  if (!edit.deleted.length && !edit.modified.length) {
    save(selected.output, 'receipt.json', {
      ...summary,
      status: 'already_complete'
    });
    console.log('Retired producer registration is already absent.');
    return;
  }
  if (selected.apply && selected.approvedPlanSha256 !== summary.planSha256)
    throw new Error(
      'Live retirement proposal differs from the approved plan; preserve concurrent changes and re-plan'
    );
  const changes = await propose(selected, command, stack, edit, role);
  console.log(
    JSON.stringify({
      ...summary,
      changeSetId: changes.ChangeSetId,
      status: 'reviewed_change_set'
    })
  );
  if (!selected.apply) {
    save(selected.output, 'receipt.json', {
      ...summary,
      changeSetId: changes.ChangeSetId,
      status: 'proposed'
    });
    return;
  }
  assertUnmoved(selected, command, stack, original);
  const receipt = { ...summary, changeSetId: changes.ChangeSetId };
  save(selected.output, 'apply-started.json', {
    ...receipt,
    status: 'apply_attempted'
  });
  try {
    command([
      'cloudformation',
      'execute-change-set',
      '--change-set-name',
      changes.ChangeSetId
    ]);
    await awaitUpdate(
      selected,
      command,
      changes.ChangeSetId,
      summary.desiredDigest
    );
    save(selected.output, 'receipt.json', { ...receipt, status: 'complete' });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.split('\n')[0]
        : 'Retirement verification failed';
    save(selected.output, 'receipt.json', {
      ...receipt,
      status: 'apply_verification_failed',
      mayHaveChangedResources: true,
      message
    });
    throw new Error(
      `Retirement apply was attempted and requires inspection; no automatic retry: ${message}`
    );
  }
  console.log('Verified the exact retirement template update.');
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Infrastructure retirement failed'
  );
  process.exitCode = 1;
});
