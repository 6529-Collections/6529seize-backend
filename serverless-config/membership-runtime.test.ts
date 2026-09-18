import { readFileSync } from 'node:fs';
import path from 'node:path';

const { resolveWorker, resolveDispatcher } =
  require('./membership-runtime.js') as {
    resolveDispatcher(input: {
      stage: unknown;
      region: unknown;
      mode?: unknown;
      scheduleEnabled?: unknown;
    }): Readonly<{
      stage: string;
      region: string;
      mode: string;
      scheduleEnabled: boolean;
      scheduleState: 'ENABLED' | 'DISABLED';
      secretArn: string;
    }>;
    resolveWorker(input: {
      stage: unknown;
      region: unknown;
      mode?: unknown;
      mappingEnabled?: unknown;
    }): Readonly<{
      stage: string;
      region: string;
      mode: string;
      mappingEnabled: boolean;
      workerConcurrency: number;
      secretArn: string;
    }>;
  };

describe('typed membership deployment controls', () => {
  it.each([
    ['staging', 'eu-west-1'],
    ['prod', 'us-east-1']
  ])('defaults %s to a boolean disabled mapping', (stage, region) => {
    const config = resolveWorker({ stage, region });
    expect(config.mode).toBe('inactive');
    expect(config.mappingEnabled).toBe(false);
    expect(config.workerConcurrency).toBe(2);
    expect(Object.isFrozen(config)).toBe(true);
  });
  it('accepts explicit staging fixture and controlled modes', () => {
    expect(
      resolveWorker({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-fixture-v1',
        mappingEnabled: 'true'
      }).mappingEnabled
    ).toBe(true);
    expect(
      resolveWorker({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-controlled-v1',
        mappingEnabled: 'false'
      })
    ).toMatchObject({ mode: 'staging-controlled-v1', mappingEnabled: false });
  });
  it('limits explicit staging backfill to 16 worker invocations', () => {
    expect(
      resolveWorker({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-backfill-v1',
        mappingEnabled: 'true'
      })
    ).toMatchObject({
      mode: 'staging-backfill-v1',
      mappingEnabled: true,
      workerConcurrency: 16
    });
    expect(
      resolveWorker({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-controlled-v1'
      }).workerConcurrency
    ).toBe(2);
  });
  it.each([
    { stage: 'production' },
    { region: 'us-east-1' },
    { mode: '' },
    { mode: 'active' },
    { mode: true },
    { mappingEnabled: true },
    { mappingEnabled: 'TRUE' },
    { mappingEnabled: '' },
    { mappingEnabled: 'true' },
    { stage: 'prod', region: 'us-east-1', mode: 'staging-fixture-v1' },
    { stage: 'prod', region: 'us-east-1', mode: 'staging-backfill-v1' }
  ])('rejects unsupported or unsafe configuration %j', (overrides) => {
    expect(() =>
      resolveWorker({ stage: 'staging', region: 'eu-west-1', ...overrides })
    ).toThrow();
  });
});

describe('typed dispatcher controls', () => {
  it.each([
    ['staging', 'eu-west-1'],
    ['prod', 'us-east-1']
  ])('defaults %s to a disabled schedule', (stage, region) => {
    const config = resolveDispatcher({ stage, region });
    expect(config.mode).toBe('inactive');
    expect(config.scheduleEnabled).toBe(false);
    expect(config.scheduleState).toBe('DISABLED');
    expect(Object.isFrozen(config)).toBe(true);
  });
  it.each(['true', 'false'])(
    'resolves fixture schedule %s without truthy strings',
    (scheduleEnabled) => {
      expect(
        resolveDispatcher({
          stage: 'staging',
          region: 'eu-west-1',
          mode: 'staging-fixture-v1',
          scheduleEnabled
        })
      ).toMatchObject({
        scheduleEnabled: scheduleEnabled === 'true',
        scheduleState: scheduleEnabled === 'true' ? 'ENABLED' : 'DISABLED'
      });
    }
  );
  it('keeps controlled staging schedule disabled unless explicitly enabled', () => {
    expect(
      resolveDispatcher({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-controlled-v1'
      })
    ).toMatchObject({ scheduleEnabled: false, scheduleState: 'DISABLED' });
  });
  it('admits explicit staging backfill scheduling without changing dispatcher concurrency or rate', () => {
    expect(
      resolveDispatcher({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-backfill-v1',
        scheduleEnabled: 'true'
      })
    ).toMatchObject({ scheduleEnabled: true, scheduleState: 'ENABLED' });
    const worker = readFileSync(
      path.join(__dirname, '../src/membershipRefreshLoop/serverless.yaml'),
      'utf8'
    );
    const dispatcher = readFileSync(
      path.join(
        __dirname,
        '../src/membershipRefreshDispatcherLoop/serverless.yaml'
      ),
      'utf8'
    );
    expect(worker).toContain(
      'reservedConcurrency: ${self:custom.membershipWorker.workerConcurrency}'
    );
    expect(worker).toContain(
      'maximumConcurrency: ${self:custom.membershipWorker.workerConcurrency}'
    );
    expect(dispatcher).toContain('reservedConcurrency: 1');
    expect(dispatcher).toContain('ScheduleExpression: rate(1 minute)');
  });
  it.each([
    { stage: 'production' },
    { region: 'us-east-1' },
    { mode: '' },
    { mode: 'active' },
    { mode: true },
    { scheduleEnabled: true },
    { scheduleEnabled: 'TRUE' },
    { scheduleEnabled: '' },
    { scheduleEnabled: 'true' },
    {
      stage: 'prod',
      region: 'us-east-1',
      mode: 'staging-fixture-v1',
      scheduleEnabled: 'false'
    },
    {
      stage: 'prod',
      region: 'us-east-1',
      mode: 'staging-backfill-v1',
      scheduleEnabled: 'false'
    }
  ])('rejects unsupported dispatcher configuration %j', (overrides) => {
    expect(() =>
      resolveDispatcher({ stage: 'staging', region: 'eu-west-1', ...overrides })
    ).toThrow();
  });
});
