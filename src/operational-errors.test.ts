import {
  operationalError,
  operationalResponse,
  withOperationalContext
} from './operational-errors';

describe('operational error envelopes', () => {
  const original = process.env;
  let output: jest.SpyInstance;
  beforeEach(() => {
    process.env = {
      ...original,
      AWS_LAMBDA_FUNCTION_NAME: 'seizeAPI',
      SENTRY_ENVIRONMENT: 'api_staging'
    };
    output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    process.env = original;
    output.mockRestore();
  });
  it('emits safe context without error messages, model text, user data or arbitrary fields', () => {
    withOperationalContext('request-123', () =>
      operationalError('MODERATION', [
        new Error('secret-webhook-url and private submitted biography'),
        { jwt: 'secret', content: 'private' }
      ])
    );
    const raw = output.mock.calls[0][0] as string;
    expect(raw).not.toMatch(/secret|biography|jwt|private|MODERATION/);
    expect(JSON.parse(raw)).toMatchObject({
      service: 'seizeAPI',
      environment: 'staging',
      correlationId: 'request-123',
      code: 'APPLICATION_ERROR'
    });
  });
  it('deduplicates the same error when the logger and handler both observe it', () => {
    const error = new Error('failure');
    withOperationalContext('request-1', () => {
      operationalError('SERVICE', [error]);
      operationalError(
        'LAMBDA_HANDLER',
        [error],
        'request-1',
        'LAMBDA_FAILURE'
      );
    });
    expect(output).toHaveBeenCalledTimes(1);
    withOperationalContext('request-2', () =>
      operationalError('SERVICE', [error])
    );
    expect(output).toHaveBeenCalledTimes(2);
  });
  it('covers resolved 5xx responses but excludes ordinary 4xx and already reported errors', () => {
    withOperationalContext('request-1', () => {
      operationalResponse({ statusCode: 400, body: 'private validation' });
      expect(output).not.toHaveBeenCalled();
      const response = { statusCode: 500, body: 'private body' };
      expect(operationalResponse(response)).toBe(response);
      operationalResponse(response);
      expect(output).toHaveBeenCalledTimes(1);
    });
    expect(String(output.mock.calls[0][0])).not.toContain('private');
  });
  it('does not emit local development content or throw if diagnostic output fails', () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    operationalError('APP', [new Error('local')]);
    expect(output).not.toHaveBeenCalled();
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    output.mockImplementation(() => {
      throw new Error('stream failure');
    });
    expect(() => operationalError('APP', [])).not.toThrow();
  });
});
