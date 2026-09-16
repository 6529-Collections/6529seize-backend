const { resolveWorker } = require('./membership-runtime.js') as {
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
    expect(Object.isFrozen(config)).toBe(true);
  });
  it('accepts only the explicit staging fixture activation', () => {
    expect(
      resolveWorker({
        stage: 'staging',
        region: 'eu-west-1',
        mode: 'staging-fixture-v1',
        mappingEnabled: 'true'
      }).mappingEnabled
    ).toBe(true);
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
    { stage: 'prod', region: 'us-east-1', mode: 'staging-fixture-v1' }
  ])('rejects unsupported or unsafe configuration %j', (overrides) => {
    expect(() =>
      resolveWorker({ stage: 'staging', region: 'eu-west-1', ...overrides })
    ).toThrow();
  });
});
