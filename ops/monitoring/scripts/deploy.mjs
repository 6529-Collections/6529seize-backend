import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { approvedAwsCli } from './aws-cli.mjs';

const awsCli = approvedAwsCli();

function run(args, capture = false) {
  const result = spawnSync(awsCli, args, {
    shell: false,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  });
  if (result.status !== 0) throw new Error('AWS monitoring operation failed');
  return capture ? result.stdout.trim() : '';
}
const environment = process.env.MONITORING_ENVIRONMENT;
const account = process.env.MONITORING_ACCOUNT_ID;
const sha = process.env.MONITORING_COMMIT_SHA;
if (
  !['prod', 'staging'].includes(environment) ||
  !/^\d{12}$/.test(account ?? '')
)
  throw new Error('Invalid monitoring target');
if (!/^[a-f0-9]{40}$/.test(sha ?? ''))
  throw new Error('Invalid monitoring commit SHA');
if (
  run(
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    true
  ) !== account
)
  throw new Error('Wrong AWS account');
const bucket = process.env.MONITORING_ARTIFACT_BUCKET;
const role = process.env.MONITORING_CLOUDFORMATION_ROLE_ARN;
if (
  !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
  !new RegExp(`^arn:[^:]+:iam::${account}:role/`).test(role ?? '')
)
  throw new Error('Invalid monitoring deployment settings');
const parameters = JSON.parse(process.env.MONITORING_PARAMETERS ?? '{}');
const template = JSON.parse(
  readFileSync(`monitoring-${environment}.json`, 'utf8')
);
parameters.Environment = environment;
if (
  !new RegExp(
    `^arn:[^:]+:iam::${account}:policy/6529-observability-${environment}-runtime-boundary$`
  ).test(parameters.RuntimePermissionsBoundaryArn ?? '')
)
  throw new Error('Invalid runtime permissions boundary');
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
if (
  !/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region ?? '') ||
  !new RegExp(`^arn:[^:]+:kms:${region}:${account}:key/[a-f0-9-]{36}$`).test(
    parameters.FallbackKmsKeyArn ?? ''
  )
)
  throw new Error('Invalid monitoring fallback key');
if (parameters.SourceAccountId === account)
  throw new Error('Monitoring must use a separate account');
for (const [key, value] of Object.entries(parameters)) {
  if (!Object.hasOwn(template.Parameters, key) || typeof value !== 'string')
    throw new Error('Invalid monitoring parameter');
  if (
    key.endsWith('SecretArn') &&
    value &&
    !new RegExp(`^arn:[^:]+:secretsmanager:[^:]+:${account}:secret:`).test(
      value
    )
  ) {
    throw new Error('Secrets must belong to the monitoring account');
  }
}
run([
  's3api',
  'head-bucket',
  '--bucket',
  bucket,
  '--expected-bucket-owner',
  account
]);
run([
  'cloudformation',
  'package',
  '--template-file',
  `monitoring-${environment}.json`,
  '--s3-bucket',
  bucket,
  '--s3-prefix',
  `${environment}/${sha}`,
  '--output-template-file',
  'packaged.json'
]);
run([
  'cloudformation',
  'deploy',
  '--template-file',
  'packaged.json',
  '--stack-name',
  `seize-monitoring-${environment}`,
  '--s3-bucket',
  bucket,
  '--s3-prefix',
  `${environment}/${sha}`,
  '--capabilities',
  'CAPABILITY_IAM',
  'CAPABILITY_AUTO_EXPAND',
  '--role-arn',
  role,
  '--no-fail-on-empty-changeset',
  '--parameter-overrides',
  ...Object.entries(parameters).map(([key, value]) => `${key}=${value}`)
]);
