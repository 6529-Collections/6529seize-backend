jest.mock('@/redis', () => ({ redisGet: jest.fn(), redisSetJson: jest.fn() }));

import { recordPrePublicationEvaluatorEvent } from './pre-publication-evaluator-guards';

describe('recordPrePublicationEvaluatorEvent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, AWS_LAMBDA_FUNCTION_NAME: 'seizeAPI' };
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.OPS_ENVIRONMENT;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function recordedEnvironment(): unknown {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    recordPrePublicationEvaluatorEvent('INVOKED');
    const record = JSON.parse(String(write.mock.calls[0][0]));
    return record.Environment;
  }

  it.each([
    ['api_prod', 'prod'],
    ['api_staging', 'staging'],
    ['development', 'dev']
  ])(
    'labels the metric from the configured environment %p',
    (configured, expected) => {
      process.env.SENTRY_ENVIRONMENT = configured;
      process.env.AWS_REGION = 'eu-west-1';
      expect(recordedEnvironment()).toBe(expected);
    }
  );

  it('does not count a deployment as production from its region alone', () => {
    process.env.AWS_REGION = 'us-east-1';
    expect(recordedEnvironment()).toBe('unknown');
  });
});
