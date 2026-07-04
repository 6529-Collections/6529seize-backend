import fc from 'fast-check';
import {
  DEFAULT_HELP_BOT_BEDROCK_MODEL_ID,
  getConfiguredBedrockAnthropicModelId,
  getPositiveIntEnvOrDefault
} from './bedrock.config';

describe('bedrock config', () => {
  const GLOBAL_MODEL_ENV = 'BEDROCK_ANTHROPIC_MODEL_ID';
  const SERVICE_MODEL_ENV = 'TEST_SERVICE_BEDROCK_MODEL_ID';
  const POSITIVE_INT_ENV = 'TEST_POSITIVE_INT_ENV';
  const previousEnv = {
    globalModel: process.env[GLOBAL_MODEL_ENV],
    serviceModel: process.env[SERVICE_MODEL_ENV],
    positiveInt: process.env[POSITIVE_INT_ENV]
  };

  afterEach(() => {
    restoreEnv(GLOBAL_MODEL_ENV, previousEnv.globalModel);
    restoreEnv(SERVICE_MODEL_ENV, previousEnv.serviceModel);
    restoreEnv(POSITIVE_INT_ENV, previousEnv.positiveInt);
  });

  it('defaults help bot to the Claude Sonnet 4.5 Bedrock inference profile', () => {
    delete process.env[SERVICE_MODEL_ENV];

    expect(DEFAULT_HELP_BOT_BEDROCK_MODEL_ID).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
    expect(
      getConfiguredBedrockAnthropicModelId(
        SERVICE_MODEL_ENV,
        DEFAULT_HELP_BOT_BEDROCK_MODEL_ID
      )
    ).toBe(DEFAULT_HELP_BOT_BEDROCK_MODEL_ID);
  });

  it('allows service model config to override the service default', () => {
    process.env[SERVICE_MODEL_ENV] = 'service-model';

    expect(
      getConfiguredBedrockAnthropicModelId(SERVICE_MODEL_ENV, 'default-model')
    ).toBe('service-model');
  });

  it('does not use a shared model fallback for service defaults', () => {
    process.env[GLOBAL_MODEL_ENV] = 'global-model';
    delete process.env[SERVICE_MODEL_ENV];

    expect(
      getConfiguredBedrockAnthropicModelId(SERVICE_MODEL_ENV, 'default-model')
    ).toBe('default-model');
  });

  it('ignores blank service model config', () => {
    process.env[SERVICE_MODEL_ENV] = '  ';

    expect(
      getConfiguredBedrockAnthropicModelId(SERVICE_MODEL_ENV, 'default-model')
    ).toBe('default-model');
  });

  it('trims service model config', () => {
    process.env[SERVICE_MODEL_ENV] = '  service-model  ';

    expect(
      getConfiguredBedrockAnthropicModelId(SERVICE_MODEL_ENV, 'default-model')
    ).toBe('service-model');
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

  it('round-trips plain decimal positive integer env values', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (value) => {
        process.env[POSITIVE_INT_ENV] = value.toString();

        expect(getPositiveIntEnvOrDefault(POSITIVE_INT_ENV, 10)).toBe(value);
      })
    );
  });

  it('rejects non-decimal and non-positive integer env values', () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => {
          const trimmed = value.trim();
          return !!trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0);
        }),
        (value) => {
          process.env[POSITIVE_INT_ENV] = value;

          expect(() =>
            getPositiveIntEnvOrDefault(POSITIVE_INT_ENV, 10)
          ).toThrow(`${POSITIVE_INT_ENV} must be a positive integer`);
        }
      )
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
