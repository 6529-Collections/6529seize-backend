import {
  assertWaveMigrationEnvironment,
  parseWaveMigrationOptions
} from './wave-migration.cli';
import { parseMigrationOptions } from './competition-migration.cli';

const wave = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const config = {
  NODE_ENV: 'local',
  DB_HOST: '127.0.0.1',
  DB_HOST_READ: '127.0.0.1'
};

describe('single-wave operator interface', () => {
  it('runs locally with just the existing wave UUID', () => {
    const options = parseWaveMigrationOptions([wave], {});
    expect(options).toMatchObject({
      waveId: wave,
      environment: 'local',
      dryRun: false,
      batch: 25
    });
    expect(() => assertWaveMigrationEnvironment(options, config)).not.toThrow();
    expect(parseWaveMigrationOptions([wave, '--dry-run'], {}).dryRun).toBe(
      true
    );
  });
  it('defaults remote environments to inspection and requires explicit live authorization', () => {
    const target = {
      ...config,
      COMPETITION_MIGRATION_ENVIRONMENT: 'production'
    };
    const inspection = parseWaveMigrationOptions([wave], target);
    expect(inspection.dryRun).toBe(true);
    expect(() =>
      assertWaveMigrationEnvironment(inspection, target)
    ).not.toThrow();
    expect(() => parseWaveMigrationOptions([wave, '--live'], target)).toThrow(
      'COMPETITION_MIGRATION_OPERATOR'
    );
    const operator = { ...target, COMPETITION_MIGRATION_OPERATOR: 'operator' };
    const live = parseWaveMigrationOptions([wave, '--live'], operator);
    expect(() => assertWaveMigrationEnvironment(live, operator)).toThrow(
      'allowlisted'
    );
    expect(() =>
      assertWaveMigrationEnvironment(live, {
        ...operator,
        COMPETITION_MIGRATION_OPERATORS: 'operator'
      })
    ).not.toThrow();
  });
  it('refuses environment mismatches, cloud secret mode and a remote local replica', () => {
    const options = parseWaveMigrationOptions([wave], {});
    expect(() =>
      assertWaveMigrationEnvironment(options, {
        ...config,
        NODE_ENV: 'production'
      })
    ).toThrow('cloud secrets');
    expect(() =>
      assertWaveMigrationEnvironment(options, {
        ...config,
        COMPETITION_MIGRATION_ENVIRONMENT: 'production'
      })
    ).toThrow('match');
    expect(() =>
      assertWaveMigrationEnvironment(options, {
        ...config,
        DB_HOST_READ: 'remote'
      })
    ).toThrow('loopback');
  });
  it.each(
    [
      [],
      ['all'],
      [wave, '--batch', '0'],
      [wave, '--batch', '101'],
      [wave, '--environment', 'prod'],
      [wave, '--live', '--dry-run'],
      [wave, '--live', '--live'],
      [wave, '--unknown', 'x']
    ].map((args) => ({ args }))
  )('refuses invalid input %j', ({ args }) => {
    expect(() => parseWaveMigrationOptions(args, {})).toThrow();
  });
  it('records one environment acceptance without requiring a competition UUID', () => {
    const options = parseMigrationOptions([
      '--environment',
      'production',
      '--action',
      'record-environment-acceptance'
    ]);
    expect(options.environment).toBe('production');
    expect(options.competition).toBeUndefined();
    expect(() =>
      parseMigrationOptions([
        '--environment',
        'production',
        '--action',
        'status'
      ])
    ).toThrow();
  });
});
