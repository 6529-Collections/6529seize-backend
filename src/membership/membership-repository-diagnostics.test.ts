import {
  assertMembershipDiagnosticInvocation,
  MEMBERSHIP_REPOSITORY_DIAGNOSTIC_ACTION
} from './membership-repository-diagnostics';

const event = { operator_action: MEMBERSHIP_REPOSITORY_DIAGNOSTIC_ACTION };
const staging = { stage: 'staging', region: 'eu-west-1' };

describe('membership repository diagnostic admission', () => {
  it('admits only the fixed action on the staging deployment', () => {
    expect(() =>
      assertMembershipDiagnosticInvocation(event, staging)
    ).not.toThrow();
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { operator_action: 'query', sql: 'SELECT 1' },
    { ...event, profile_id: 'caller-selected' },
    { ...event, sql: 'SELECT 1' },
    { Records: [{ body: JSON.stringify(event) }] },
    { source: 'aws.events', 'detail-type': 'Scheduled Event', ...event }
  ])('rejects open or triggered input %#', (input) => {
    expect(() => assertMembershipDiagnosticInvocation(input, staging)).toThrow(
      'Unsupported membership diagnostic invocation'
    );
  });

  it.each([
    { stage: 'prod', region: 'us-east-1' },
    { stage: 'prod', region: 'eu-west-1' },
    { stage: 'staging', region: 'us-east-1' },
    { stage: undefined, region: 'eu-west-1' },
    { stage: 'staging', region: undefined }
  ])('rejects mismatched deployment identity %#', (deployment) => {
    expect(() =>
      assertMembershipDiagnosticInvocation(event, deployment)
    ).toThrow('Membership repository diagnostics require staging');
  });

  it('pins carrier admission before shared secrets can replace environment values', async () => {
    const originalStage = process.env.MEMBERSHIP_DIAGNOSTIC_STAGE;
    const originalRegion = process.env.AWS_REGION;
    const runDiagnostic = jest.fn(async () => ({ status: 'passed' }));
    const initialize = jest.fn(async (operation: () => Promise<unknown>) => {
      process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = 'prod';
      process.env.AWS_REGION = 'us-east-1';
      return operation();
    });
    let handler: (input: unknown) => Promise<unknown>;
    try {
      process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = 'staging';
      process.env.AWS_REGION = 'eu-west-1';
      jest.isolateModules(() => {
        jest.doMock('@/secrets', () => ({ doInDbContext: initialize }));
        jest.doMock('@/sentry.context', () => ({
          wrapLambdaHandler: (fn: unknown) => fn
        }));
        jest.doMock('./membership-repository-diagnostics', () => ({
          assertMembershipDiagnosticInvocation,
          runMembershipRepositoryDiagnostics: runDiagnostic
        }));
        handler = jest.requireActual<{
          handler: (input: unknown) => Promise<unknown>;
        }>('@/customReplayLoop/index').handler;
      });
      await expect(handler!(event)).resolves.toEqual({
        status: 'passed',
        deployment_stage: 'staging',
        carrier_normal_membership_work: 'absent'
      });
      expect(initialize).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          syncEntities: false,
          skipRedis: true
        })
      );
      expect(runDiagnostic).toHaveBeenCalledTimes(1);
    } finally {
      if (originalStage === undefined)
        delete process.env.MEMBERSHIP_DIAGNOSTIC_STAGE;
      else process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = originalStage;
      if (originalRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = originalRegion;
      jest.dontMock('@/secrets');
      jest.dontMock('@/sentry.context');
      jest.dontMock('./membership-repository-diagnostics');
    }
  });

  it('rejects the production carrier before database or secret initialization', async () => {
    const originalStage = process.env.MEMBERSHIP_DIAGNOSTIC_STAGE;
    const originalRegion = process.env.AWS_REGION;
    const initialize = jest.fn();
    let handler: (input: unknown) => Promise<unknown>;
    try {
      process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = 'prod';
      process.env.AWS_REGION = 'us-east-1';
      jest.isolateModules(() => {
        jest.doMock('@/secrets', () => ({ doInDbContext: initialize }));
        jest.doMock('@/sentry.context', () => ({
          wrapLambdaHandler: (fn: unknown) => fn
        }));
        handler = jest.requireActual<{
          handler: (input: unknown) => Promise<unknown>;
        }>('@/customReplayLoop/index').handler;
      });
      await expect(handler!(event)).rejects.toThrow(
        'Membership repository diagnostics require staging'
      );
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      if (originalStage === undefined)
        delete process.env.MEMBERSHIP_DIAGNOSTIC_STAGE;
      else process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = originalStage;
      if (originalRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = originalRegion;
      jest.dontMock('@/secrets');
      jest.dontMock('@/sentry.context');
    }
  });
});
