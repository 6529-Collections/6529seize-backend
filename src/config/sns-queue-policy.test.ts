import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, Tags } from 'yaml';

type Resource = { Type?: string; Properties?: Record<string, any> };

const sourceRoot = join(__dirname, '..');

// CloudFormation short-form intrinsics (`!Ref X`, `!GetAtt X.Arn`, `!Sub ...`)
// parsed into their long forms, so both spellings compare the same.
const INTRINSICS = [
  'And',
  'Base64',
  'Cidr',
  'Equals',
  'FindInMap',
  'GetAZs',
  'GetAtt',
  'If',
  'ImportValue',
  'Join',
  'Not',
  'Or',
  'Select',
  'Split',
  'Sub'
];

function longForm(name: string, value: unknown): Record<string, unknown> {
  if (name === 'Ref') return { Ref: value };
  if (name === 'GetAtt' && typeof value === 'string') {
    const dot = value.indexOf('.');
    return { 'Fn::GetAtt': [value.slice(0, dot), value.slice(dot + 1)] };
  }
  return { [`Fn::${name}`]: value };
}

const cloudFormationTags: Tags = ['Ref', ...INTRINSICS].flatMap((name) =>
  (['scalar', 'seq', 'map'] as const).map((kind) => ({
    tag: `!${name}`,
    ...(kind === 'scalar' ? {} : { collection: kind }),
    resolve: (value: any) =>
      longForm(name, typeof value === 'string' ? value : value.toJSON())
  }))
) as Tags;

function parseServerlessYaml(
  source: string,
  file: string
): Record<string, Resource> {
  const document = parseDocument(source, {
    customTags: cloudFormationTags,
    logLevel: 'silent'
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length) {
    throw new Error(
      `${file} does not parse cleanly: ${problems
        .map((problem) => problem.message)
        .join('; ')}`
    );
  }
  return document.toJS()?.resources?.Resources ?? {};
}

function serverlessFiles(): string[] {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sourceRoot, entry.name, 'serverless.yaml'))
    .filter((file) => existsSync(file));
}

/** Logical id of the queue a `Ref` or `Fn::GetAtt` points at. */
function referencedResource(value: unknown): string {
  if (value && typeof value === 'object') {
    if ('Ref' in value) return String((value as { Ref: unknown }).Ref);
    const getAtt = (value as { 'Fn::GetAtt'?: unknown })['Fn::GetAtt'];
    if (Array.isArray(getAtt)) return String(getAtt[0]);
    if (typeof getAtt === 'string') return getAtt.split('.')[0];
  }
  throw new Error(`Unsupported queue reference: ${JSON.stringify(value)}`);
}

function relative(file: string): string {
  return file
    .slice(sourceRoot.length + 1)
    .split('\\')
    .join('/');
}

const resourcesByFile = serverlessFiles().map(
  (file): [string, Record<string, Resource>] => [
    file,
    parseServerlessYaml(readFileSync(file, 'utf8'), file)
  ]
);

const snsStatements = resourcesByFile.flatMap(([file, resources]) =>
  Object.entries(resources)
    .filter(([, resource]) => resource.Type === 'AWS::SQS::QueuePolicy')
    .flatMap(([name, resource]) => {
      const queues: string[] = (resource.Properties?.Queues ?? []).map(
        referencedResource
      );
      return (resource.Properties?.PolicyDocument?.Statement ?? [])
        .filter(
          (statement: any) =>
            statement.Principal?.Service === 'sns.amazonaws.com'
        )
        .map((statement: any) => ({
          label: `${relative(file)}#${name}`,
          queues: queues.map((queue) => `${relative(file)}#${queue}`),
          statement,
          topics: Object.values(resources)
            .filter((other) => other.Type === 'AWS::SNS::Subscription')
            .filter((subscription) =>
              queues.includes(
                referencedResource(subscription.Properties?.Endpoint)
              )
            )
            .map((subscription) => subscription.Properties?.TopicArn)
        }));
    })
);

// Every queue that SNS delivers to. Adding or removing one is a deliberate
// change to this list.
const EXPECTED_SNS_DELIVERY_QUEUES = [
  'overRatesRevocationLoop/serverless.yaml#OverRatesRevocationStartQueue',
  'waveScoreRefreshLoop/serverless.yaml#WaveScoreRefreshStartQueue',
  'xTdhLoop/serverless.yaml#XTdhStartQueue'
];

describe('SNS delivery queue policies', () => {
  it('parses the CloudFormation reference forms', () => {
    expect(referencedResource({ Ref: 'Queue' })).toBe('Queue');
    expect(referencedResource({ 'Fn::GetAtt': ['Queue', 'Arn'] })).toBe(
      'Queue'
    );
    expect(referencedResource({ 'Fn::GetAtt': 'Queue.Arn' })).toBe('Queue');
    const parsed = parseDocument(
      [
        'a: !Ref Queue',
        'b: !GetAtt Queue.Arn',
        'c: !GetAtt',
        '  - Queue',
        '  - Arn'
      ].join('\n'),
      { customTags: cloudFormationTags }
    ).toJS();
    expect(parsed).toEqual({
      a: { Ref: 'Queue' },
      b: { 'Fn::GetAtt': ['Queue', 'Arn'] },
      c: { 'Fn::GetAtt': ['Queue', 'Arn'] }
    });
  });

  it('fails on a file that does not parse', () => {
    expect(() =>
      parseServerlessYaml('resources: [1, 2', 'broken.yaml')
    ).toThrow('broken.yaml does not parse cleanly');
    expect(() =>
      parseServerlessYaml('a: !Unknown value', 'unknown-tag.yaml')
    ).toThrow('unknown-tag.yaml does not parse cleanly');
  });

  it('rejects a queue reference it cannot resolve', () => {
    expect(() => referencedResource('arn:aws:sqs:us-east-1:1:queue')).toThrow(
      'Unsupported queue reference'
    );
  });

  it('finds exactly the expected SNS delivery queues', () => {
    expect(
      snsStatements
        .flatMap((entry) => entry.queues)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(EXPECTED_SNS_DELIVERY_QUEUES);
  });

  it.each(snsStatements.map((entry) => [entry.label, entry]))(
    '%s allows only message delivery from its subscribed topic',
    (_label, { statement, topics }) => {
      expect([statement.Action].flat()).toEqual(['sqs:SendMessage']);
      expect(topics).toHaveLength(1);
      expect(statement.Condition).toEqual({
        ArnEquals: { 'aws:SourceArn': topics[0] }
      });
    }
  );
});
