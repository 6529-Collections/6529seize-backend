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
}

const config = parse(readFileSync(join(__dirname, 'serverless.yaml'), 'utf8'), {
  customTags: [{ tag: '!GetAtt', resolve: (value: string) => value }]
}) as RecoveryConfig;

describe('release-note recovery infrastructure', () => {
  it('serializes queued and operator work without any periodic trigger', () => {
    const fn = config.functions.releaseNotesGenerationLoop;
    expect(fn.reservedConcurrency).toBe(1);
    expect(fn.events).toEqual([
      expect.objectContaining({
        sqs: expect.objectContaining({ batchSize: 1 })
      })
    ]);
    expect(fn.events.some((event) => event.schedule)).toBe(false);
  });
});
