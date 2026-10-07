import {
  assertMigrationLambdaEnvironment,
  assertMigrationLambdaOperator,
  parseMigrationLambdaInput
} from './migration-input';
import { migrationFixtureAcceptance } from '@/tests/fixtures/competition-migration.fixture';

const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const inspection = { environment: 'staging', wave_id: waveId };
const live = {
  ...inspection,
  action: 'migrate',
  live: true,
  operator: 'operator',
  reason: 'reviewed pilot'
};

describe('manual migration Lambda input', () => {
  it('requires an explicit remote environment and one real wave, defaulting to inspection', () => {
    expect(parseMigrationLambdaInput(inspection)).toMatchObject({
      action: 'inspect',
      live: false,
      batch: 25,
      auto_continue: true,
      invocation_seconds: 120,
      max_duration_minutes: 60
    });
  });
  it.each([
    undefined,
    null,
    {},
    { ...inspection, environment: 'local' },
    { ...inspection, wave_id: 'all' },
    { ...inspection, wave_id: [waveId] },
    { ...inspection, DB_HOST: 'another-db' },
    { ...inspection, schema_scope: 'full' },
    { ...live, live: 'true' },
    { ...live, operator: undefined },
    { ...live, reason: undefined },
    { ...live, batch: 0 },
    { ...live, batch: 101 },
    { ...live, invocation_seconds: 900 },
    { ...live, max_duration_minutes: 1441 },
    { ...live, action: 'inspect' },
    { ...inspection, acceptance: {} },
    { ...inspection, exception: 'BYPASS' },
    { ...live, continuation: { run_id: waveId } },
    {
      ...live,
      auto_continue: false,
      continuation: { run_id: waveId, started_at: 1, deadline_at: 2 }
    }
  ])('rejects unsafe, malformed or inapplicable input %j', (input) => {
    expect(() => parseMigrationLambdaInput(input)).toThrow();
  });
  it('accepts an inline reviewed environment approval without a wave or filesystem path', () => {
    const input = {
      environment: 'production',
      action: 'record-environment-acceptance',
      live: true,
      operator: 'fixture-operator',
      reason: 'disposable test',
      acceptance: migrationFixtureAcceptance(Date.now())
    };
    expect(parseMigrationLambdaInput(input).acceptance).toEqual(
      input.acceptance
    );
    expect(() =>
      parseMigrationLambdaInput({ ...input, wave_id: waveId })
    ).toThrow();
    expect(() =>
      parseMigrationLambdaInput({ ...input, acceptance: '/tmp/approval.json' })
    ).toThrow();
  });
  it('validates owned stops and repair evidence without exposing an exception-clearing action', () => {
    expect(
      parseMigrationLambdaInput({
        ...live,
        action: 'record-exception',
        exception: 'OPERATOR_STOP'
      }).exception
    ).toBe('OPERATOR_STOP');
    expect(() =>
      parseMigrationLambdaInput({ ...live, action: 'clear-exception' })
    ).toThrow();
    expect(() =>
      parseMigrationLambdaInput({
        ...live,
        action: 'review-repair',
        evidence: 'http://example.test'
      })
    ).toThrow();
  });
  it.each([
    ['staging', 'staging', 'eu-west-1'],
    ['production', 'production', 'us-east-1']
  ])(
    'pins %s to its deployment and region',
    (environment, deployed, region) => {
      const input = parseMigrationLambdaInput({ ...inspection, environment });
      expect(() =>
        assertMigrationLambdaEnvironment(input, deployed, region)
      ).not.toThrow();
      expect(() =>
        assertMigrationLambdaEnvironment(input, 'local', region)
      ).toThrow();
      expect(() =>
        assertMigrationLambdaEnvironment(input, deployed, 'ap-south-1')
      ).toThrow();
      expect(() =>
        assertMigrationLambdaEnvironment(input, undefined, region)
      ).toThrow();
    }
  );
  it('requires a configured allowlisted operator for every live operation', () => {
    const input = parseMigrationLambdaInput(live);
    expect(() =>
      assertMigrationLambdaOperator(input, 'other, operator ')
    ).not.toThrow();
    expect(() => assertMigrationLambdaOperator(input, undefined)).toThrow();
    expect(() =>
      assertMigrationLambdaOperator(input, 'another-operator')
    ).toThrow();
    expect(() =>
      assertMigrationLambdaOperator(
        parseMigrationLambdaInput(inspection),
        undefined
      )
    ).not.toThrow();
  });
});
