import {
  migrationLambdaEnvironment,
  parseMigrationLambdaInput
} from './migration-input';

const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';

describe('manual migration Lambda input', () => {
  it('requires only a wave ID without operator, reason or environment', () => {
    expect(parseMigrationLambdaInput({ wave_id: waveId })).toEqual({
      wave_id: waveId
    });
  });
  it.each([
    undefined,
    null,
    {},
    { wave_id: 'all' },
    { wave_id: [waveId] },
    { wave_id: waveId, DB_HOST: 'another-db' },
    { wave_id: waveId, environment: 'production' },
    { wave_id: waveId, live: false },
    { wave_id: waveId, operator: 'operator' },
    { wave_id: waveId, action: 'rollback' },
    { wave_id: waveId, continuation: { run_id: waveId } }
  ])('rejects malformed input and deployment overrides %j', (input) => {
    expect(() => parseMigrationLambdaInput(input)).toThrow(
      'Invalid migration input'
    );
  });
  it('round trips the internal continuation without adding manual prerequisites', () => {
    const input = {
      wave_id: waveId,
      continuation: { run_id: waveId, started_at: 1, deadline_at: 2 }
    };
    expect(parseMigrationLambdaInput(input)).toEqual(input);
  });
  it.each([
    ['staging', 'eu-west-1'],
    ['production', 'us-east-1']
  ])('derives %s only from the pinned deployment', (environment, region) => {
    expect(migrationLambdaEnvironment(environment, region)).toBe(environment);
  });
  it.each([
    [undefined, 'eu-west-1'],
    ['local', 'eu-west-1'],
    ['staging', 'us-east-1'],
    ['production', 'eu-west-1']
  ])('refuses misconfigured deployments %j %j', (environment, region) => {
    expect(() => migrationLambdaEnvironment(environment, region)).toThrow(
      'deployment'
    );
  });
});
