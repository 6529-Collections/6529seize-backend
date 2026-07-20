const mockGetSecretValue = jest.fn();

describe('Release Bus runtime secrets', () => {
  const variableNames = [
    'RELEASE_BUS_GITHUB_PRIVATE_KEY',
    'RELEASE_BUS_GITHUB_WEBHOOK_SECRET',
    'RELEASE_BUS_WORKFLOW_AUTH_TOKEN'
  ] as const;
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousValues = Object.fromEntries(
    variableNames.map((name) => [name, process.env[name]])
  );

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    for (const name of variableNames) delete process.env[name];
  });

  afterAll(() => {
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
    for (const name of variableNames) {
      const previousValue = previousValues[name];
      if (previousValue === undefined) delete process.env[name];
      else process.env[name] = previousValue;
    }
  });

  it('loads every Release Bus credential from the shared Lambda secret', async () => {
    jest.doMock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManager: jest.fn(() => ({
        getSecretValue: mockGetSecretValue
      }))
    }));
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({
        RELEASE_BUS_GITHUB_PRIVATE_KEY: 'private-key',
        RELEASE_BUS_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        RELEASE_BUS_WORKFLOW_AUTH_TOKEN: 'workflow-token'
      })
    });

    const { loadSecrets } = await import('@/env');
    await loadSecrets();

    expect(process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY).toBe('private-key');
    expect(process.env.RELEASE_BUS_GITHUB_WEBHOOK_SECRET).toBe(
      'webhook-secret'
    );
    expect(process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN).toBe('workflow-token');
  });
});
