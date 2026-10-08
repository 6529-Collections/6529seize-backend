import type { Context } from 'aws-lambda';
import { createMigrationHandler, queueMigrationContinuation } from './index';
import { doInDbContext } from '@/secrets';
import { executeMigrationLambdaInput } from './migration-runner';
import { CompetitionMigrationService } from '@/competitions/competition-migration.service';
import { parseMigrationLambdaInput } from './migration-input';

jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (fn: () => Promise<unknown>) => fn())
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));
jest.mock('@/competitions/competition-migration.service', () => ({
  CompetitionMigrationService: jest.fn()
}));
jest.mock('./migration-runner', () => ({
  executeMigrationLambdaInput: jest
    .fn()
    .mockResolvedValue({ outcome: 'COMPLETE' })
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
  InvokeCommand: jest.fn().mockImplementation((input: unknown) => ({ input }))
}));
const mockSend = jest.fn().mockResolvedValue({ StatusCode: 202 });
const mockDestroy = jest.fn();
const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const event = { environment: 'staging', wave_id: waveId };
const functionArn =
  'arn:aws:lambda:eu-west-1:987989283142:function:competitionMigrationLoop:12';
const context = {
  awsRequestId: 'request-id',
  invokedFunctionArn: functionArn,
  getRemainingTimeInMillis: () => 900000
} as Context;
const handleMigration = createMigrationHandler({
  environment: 'staging',
  region: 'eu-west-1',
  operators: 'operator'
});

describe('migration Lambda wiring', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MIGRATION_DEPLOYED_ENVIRONMENT = 'staging';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.COMPETITION_MIGRATION_OPERATORS = 'operator';
    jest.mocked(doInDbContext).mockImplementation(async (fn) => fn());
    mockSend.mockResolvedValue({ StatusCode: 202 });
  });
  afterAll(() => {
    process.env = originalEnv;
  });
  it('rejects absent inputs and the wrong deployment before connecting to the database', async () => {
    await expect(handleMigration({}, context)).rejects.toThrow('input');
    await expect(
      handleMigration({ ...event, environment: 'production' }, context)
    ).rejects.toThrow('deployment');
    expect(doInDbContext).not.toHaveBeenCalled();
  });
  it('uses regional cloud configuration without schema synchronization or Redis initialization', async () => {
    await expect(handleMigration(event, context)).resolves.toEqual({
      outcome: 'COMPLETE'
    });
    expect(doInDbContext).toHaveBeenCalledWith(expect.any(Function), {
      logger: expect.anything(),
      syncEntities: false,
      skipRedis: true
    });
    expect(CompetitionMigrationService).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      'staging'
    );
  });
  it('captures the deployed identity and explicit operator list before shared secrets can overwrite them', async () => {
    jest.mocked(doInDbContext).mockImplementation(async (fn) => {
      process.env.MIGRATION_DEPLOYED_ENVIRONMENT = 'production';
      process.env.AWS_REGION = 'us-east-1';
      process.env.COMPETITION_MIGRATION_OPERATORS = 'attacker';
      return fn();
    });
    await handleMigration(
      {
        ...event,
        action: 'migrate',
        live: true,
        operator: 'operator',
        reason: 'reviewed pilot'
      },
      context
    );
    expect(CompetitionMigrationService).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      'staging'
    );
    expect(executeMigrationLambdaInput).toHaveBeenCalled();
    // The same warm function still uses its actual staging identity/override.
    await handleMigration(
      {
        ...event,
        action: 'migrate',
        live: true,
        operator: 'operator',
        reason: 'reviewed pilot'
      },
      context
    );
    expect(CompetitionMigrationService).toHaveBeenCalledTimes(2);
    expect(
      jest
        .mocked(CompetitionMigrationService)
        .mock.calls.every((call) => call[3] === 'staging')
    ).toBe(true);
  });
  it('checks the operator list loaded from regional secrets when no explicit override exists', async () => {
    const secretConfigured = createMigrationHandler({
      environment: 'staging',
      region: 'eu-west-1',
      operators: undefined
    });
    delete process.env.COMPETITION_MIGRATION_OPERATORS;
    jest.mocked(doInDbContext).mockImplementation(async (fn) => {
      process.env.COMPETITION_MIGRATION_OPERATORS = 'operator';
      return fn();
    });
    await expect(
      secretConfigured(
        {
          ...event,
          action: 'migrate',
          live: true,
          operator: 'attacker',
          reason: 'pilot'
        },
        context
      )
    ).rejects.toThrow('allowlisted');
    expect(executeMigrationLambdaInput).not.toHaveBeenCalled();
  });
  it('queues only the same function/version asynchronously and serializes validated inputs', async () => {
    const input = parseMigrationLambdaInput({
      ...event,
      action: 'migrate',
      live: true,
      operator: 'operator',
      reason: 'pilot'
    });
    await queueMigrationContinuation(input, functionArn, 'eu-west-1');
    const command = mockSend.mock.calls[0][0] as {
      input: { FunctionName: string; InvocationType: string; Payload: Buffer };
    };
    expect(command.input.FunctionName).toBe(functionArn);
    expect(command.input.InvocationType).toBe('Event');
    expect(JSON.parse(command.input.Payload.toString())).toEqual(input);
    expect(mockDestroy).toHaveBeenCalled();
    mockSend.mockResolvedValueOnce({ StatusCode: 200 });
    await expect(
      queueMigrationContinuation(input, functionArn, 'eu-west-1')
    ).rejects.toThrow('not accepted');
  });
  it('always disposes the Lambda client when continuation publication fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(
      queueMigrationContinuation(
        parseMigrationLambdaInput(event),
        functionArn,
        'eu-west-1'
      )
    ).rejects.toThrow('network');
    expect(mockDestroy).toHaveBeenCalled();
  });
});
