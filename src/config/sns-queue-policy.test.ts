import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

type Resource = { Type?: string; Properties?: Record<string, any> };

const sourceRoot = join(__dirname, '..');

function serverlessResources(): [string, Record<string, Resource>][] {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sourceRoot, entry.name, 'serverless.yaml'))
    .filter((file) => existsSync(file))
    .map((file): [string, Record<string, Resource>] => [
      file,
      parseDocument(readFileSync(file, 'utf8'), {
        logLevel: 'silent'
      }).toJS()?.resources?.Resources ?? {}
    ])
    .filter(([, resources]) => Object.keys(resources).length > 0);
}

function referencedQueue(value: unknown): string | undefined {
  if (Array.isArray(value)) return String(value[0]);
  if (typeof value === 'string') return value.split('.')[0];
  if (value && typeof value === 'object' && 'Ref' in value) {
    return String((value as { Ref: unknown }).Ref);
  }
  return undefined;
}

const snsStatements = serverlessResources().flatMap(([file, resources]) =>
  Object.entries(resources)
    .filter(([, resource]) => resource.Type === 'AWS::SQS::QueuePolicy')
    .flatMap(([name, resource]) =>
      (resource.Properties?.PolicyDocument?.Statement ?? [])
        .filter(
          (statement: any) =>
            statement.Principal?.Service === 'sns.amazonaws.com'
        )
        .map((statement: any) => ({
          label: `${file.slice(sourceRoot.length + 1)}#${name}`,
          statement,
          topics: Object.values(resources)
            .filter((other) => other.Type === 'AWS::SNS::Subscription')
            .filter((subscription) =>
              (resource.Properties?.Queues ?? [])
                .map(referencedQueue)
                .includes(referencedQueue(subscription.Properties?.Endpoint))
            )
            .map((subscription) => subscription.Properties?.TopicArn)
        }))
    )
);

describe('SNS delivery queue policies', () => {
  it('finds the SNS-subscribed queues', () => {
    expect(snsStatements.length).toBeGreaterThanOrEqual(3);
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
