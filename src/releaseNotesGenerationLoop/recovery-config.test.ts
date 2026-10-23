import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

interface RecoveryConfig {
  functions: {
    releaseNotesGenerationLoop: {
      reservedConcurrency: number;
      events: Array<{
        sqs?: { batchSize: number };
        schedule?: { name: string; rate: string };
      }>;
    };
  };
  resources: {
    Conditions: Record<string, { 'Fn::Equals': string[] }>;
    extensions: Record<string, { Condition: string }>;
  };
}

const config = parse(readFileSync(join(__dirname, 'serverless.yaml'), 'utf8'), {
  customTags: [{ tag: '!GetAtt', resolve: (value: string) => value }]
}) as RecoveryConfig;

describe('release-note recovery infrastructure', () => {
  it('serializes scheduled, SQS and operator invocations on the same function', () => {
    const fn = config.functions.releaseNotesGenerationLoop;
    expect(fn.reservedConcurrency).toBe(1);
    expect(fn.events.find((event) => event.sqs)?.sqs?.batchSize).toBe(1);
    expect(fn.events.find((event) => event.schedule)?.schedule?.rate).toBe(
      'rate(5 minutes)'
    );
  });

  it('creates both the named rule and its invoke permission only for production', () => {
    const naming = require('serverless/lib/plugins/aws/lib/naming') as {
      getScheduleLogicalId: (name: string, index: number) => string;
      getLambdaSchedulePermissionLogicalId: (
        name: string,
        index: number
      ) => string;
    };
    const condition = 'ReleaseNoteRecoveryProduction';
    expect(config.resources.Conditions[condition]['Fn::Equals']).toEqual([
      '${opt:stage, self:provider.stage}',
      'prod'
    ]);
    expect(
      config.resources.extensions[
        naming.getScheduleLogicalId('releaseNotesGenerationLoop', 1)
      ].Condition
    ).toBe(condition);
    expect(
      config.resources.extensions[
        naming.getLambdaSchedulePermissionLogicalId(
          'releaseNotesGenerationLoop',
          1
        )
      ].Condition
    ).toBe(condition);
  });
});
