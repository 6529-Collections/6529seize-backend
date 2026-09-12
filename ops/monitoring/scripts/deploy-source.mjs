import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const environment = process.env.MONITORING_ENVIRONMENT;
const account = process.env.SOURCE_ACCOUNT_ID;
const monitoring = process.env.MONITORING_ACCOUNT_ID;
const sha = process.env.MONITORING_COMMIT_SHA;
if (
  !['prod', 'staging'].includes(environment) ||
  !/^\d{12}$/.test(account ?? '') ||
  !/^\d{12}$/.test(monitoring ?? '') ||
  monitoring === account ||
  !/^[a-f0-9]{40}$/.test(sha ?? '')
) {
  throw new Error('Invalid source deployment target');
}
const coverage = JSON.parse(
  readFileSync(`coverage-${environment}.json`, 'utf8')
);
const regions = new Set(coverage.services.map((service) => service.region));
if (regions.size !== 1)
  throw new Error(
    'Source coverage requires explicit multi-region stack handling'
  );
const region = [...regions][0];
function run(args, capture = false) {
  const result = spawnSync('aws', [...args, '--region', region], {
    shell: false,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  });
  if (result.status !== 0)
    throw new Error('AWS source monitoring operation failed');
  return capture ? result.stdout.trim() : '';
}
if (
  run(
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    true
  ) !== account
) {
  throw new Error('Wrong source account');
}
const bus = process.env.MONITORING_EVENT_BUS_ARN;
if (
  !new RegExp(
    `^arn:[^:]+:events:[^:]+:${monitoring}:event-bus/seize-monitoring-${environment}-events$`
  ).test(bus ?? '')
) {
  throw new Error('Wrong monitoring bus');
}
const bucket = process.env.SOURCE_ARTIFACT_BUCKET;
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? ''))
  throw new Error('Invalid source artifact bucket');
const role = process.env.SOURCE_CLOUDFORMATION_ROLE_ARN;
if (role && !new RegExp(`^arn:[^:]+:iam::${account}:role/`).test(role))
  throw new Error('Wrong source CloudFormation role');
const topic = process.env.SOURCE_ALARM_TOPIC_ARN ?? '';
if (
  topic &&
  !new RegExp(`^arn:[^:]+:sns:${region}:${account}:[a-zA-Z0-9_-]+$`).test(topic)
)
  throw new Error('Wrong source alarm topic');
run([
  's3api',
  'head-bucket',
  '--bucket',
  bucket,
  '--expected-bucket-owner',
  account
]);
const functions = JSON.parse(
  run(
    [
      'lambda',
      'list-functions',
      '--query',
      'Functions[].FunctionName',
      '--output',
      'json'
    ],
    true
  )
);
const groups = JSON.parse(
  run(
    [
      'logs',
      'describe-log-groups',
      '--log-group-name-prefix',
      '/aws/lambda/',
      '--query',
      'logGroups[].logGroupName',
      '--output',
      'json'
    ],
    true
  )
);
for (const name of coverage.services.flatMap((service) => service.functions)) {
  const group = `/aws/lambda/${name}`;
  if (!functions.includes(name) || !groups.includes(group))
    throw new Error(`Catalog function/log group is missing: ${name}`);
  const filters = JSON.parse(
    run(
      [
        'logs',
        'describe-subscription-filters',
        '--log-group-name',
        group,
        '--query',
        'subscriptionFilters[].destinationArn',
        '--output',
        'json'
      ],
      true
    )
  );
  if (
    filters.length >= 2 &&
    !filters.some((arn) =>
      arn.endsWith(`:function:seize-monitoring-${environment}-logs`)
    )
  ) {
    throw new Error(`No subscription capacity for ${name}`);
  }
}
run([
  'cloudformation',
  'package',
  '--template-file',
  `source-${environment}.json`,
  '--s3-bucket',
  bucket,
  '--s3-prefix',
  `monitoring-source/${environment}/${sha}`,
  '--output-template-file',
  'packaged-source.json'
]);
run([
  'cloudformation',
  'deploy',
  '--template-file',
  'packaged-source.json',
  '--stack-name',
  `seize-monitoring-${environment}-source`,
  '--capabilities',
  'CAPABILITY_NAMED_IAM',
  'CAPABILITY_AUTO_EXPAND',
  ...(role ? ['--role-arn', role] : []),
  '--no-fail-on-empty-changeset',
  '--parameter-overrides',
  `Environment=${environment}`,
  `MonitoringEventBusArn=${bus}`,
  `ExistingAlarmTopicArn=${topic}`
]);
