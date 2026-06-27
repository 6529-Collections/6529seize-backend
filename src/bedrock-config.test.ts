import {
  BEDROCK_ANTHROPIC_MODEL_ID_ENV,
  DEFAULT_BEDROCK_ANTHROPIC_MODEL_ID,
  getConfiguredBedrockAnthropicModelId,
  getPositiveIntEnvOrDefault
} from './bedrock.config';

describe('bedrock config', () => {
  const SERVICE_MODEL_ENV = 'TEST_SERVICE_BEDROCK_MODEL_ID';
  const POSITIVE_INT_ENV = 'TEST_POSITIVE_INT_ENV';
  const previousEnv = {
    globalModel: process.env[BEDROCK_ANTHROPIC_MODEL_ID_ENV],
    serviceModel: process.env[SERVICE_MODEL_ENV],
    positiveInt: process.env[POSITIVE_INT_ENV]
  };

  afterEach(() => {
    restoreEnv(BEDROCK_ANTHROPIC_MODEL_ID_ENV, previousEnv.globalModel);
    restoreEnv(SERVICE_MODEL_ENV, previousEnv.serviceModel);
    restoreEnv(POSITIVE_INT_ENV, previousEnv.positiveInt);
  });

  it('defaults to the shared Claude 3.5 Sonnet Bedrock model', () => {
    delete process.env[BEDROCK_ANTHROPIC_MODEL_ID_ENV];
    delete process.env[SERVICE_MODEL_ENV];

    expect(getConfiguredBedrockAnthropicModelId(SERVICE_MODEL_ENV)).toBe(
      DEFAULT_BEDROCK_ANTHROPIC_MODEL_ID
    );
  });

  it('allows service model config to override the shared model config', () => {
    process.env[BEDROCK_ANTHROPIC_MODEL_ID_ENV] = 'global-model';
    process.env[SERVICE_MODEL_ENV] = 'service-model';

    expect(getConfiguredBedrockAnthropicModelId(SERVICE_MODEL_ENV)).toBe(
      'service-model'
    );
  });

  it('reads positive integer env values with a default', () => {
    delete process.env[POSITIVE_INT_ENV];
    expect(getPositiveIntEnvOrDefault(POSITIVE_INT_ENV, 10)).toBe(10);

    process.env[POSITIVE_INT_ENV] = '15';
    expect(getPositiveIntEnvOrDefault(POSITIVE_INT_ENV, 10)).toBe(15);
  });

  it('rejects invalid positive integer env values', () => {
    process.env[POSITIVE_INT_ENV] = '0';

    expect(() => getPositiveIntEnvOrDefault(POSITIVE_INT_ENV, 10)).toThrow(
      `${POSITIVE_INT_ENV} must be a positive integer`
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
