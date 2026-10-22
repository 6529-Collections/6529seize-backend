import { reportLoopHealth } from './loop-health';

describe('business progress emitter', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, AWS_LAMBDA_FUNCTION_NAME: 'delegationsLoop' };
  });
  afterEach(() => {
    process.env = original;
    jest.restoreAllMocks();
  });
  it('emits only explicitly supplied business observations, without application content', () => {
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    reportLoopHealth({
      operation: 'indexing',
      pending: true,
      recovery: 'automatic',
      progressAt: 100,
      oldestPendingAt: 90,
      ...{ privateMessage: 'PRIVATE' }
    });
    const output = String(write.mock.calls[0][0]);
    expect(JSON.parse(output)).toMatchObject({
      _type: '6529.ops.loop-health.v1',
      service: 'delegationsLoop',
      progressAt: 100
    });
    expect(output).not.toContain('PRIVATE');
  });
  it('remains silent outside Lambda and never replaces the business failure when stdout fails', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('stdout failed');
    });
    expect(() =>
      reportLoopHealth({
        operation: 'indexing',
        pending: true,
        recovery: 'unknown'
      })
    ).not.toThrow();
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    write.mockClear();
    reportLoopHealth({
      operation: 'indexing',
      pending: false,
      recovery: 'automatic'
    });
    expect(write).not.toHaveBeenCalled();
  });
});
