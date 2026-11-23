import { existsSync, readFileSync } from 'node:fs';

const health = require('./health');

const quiet = {
  invocations: 3,
  errors: 0,
  baselineInvocations: 100,
  baselineErrors: 0,
  badLines: [] as string[],
  authLines: ['[DB HOST x] [AUTH IAM] [SYNC ENTITIES false]'],
  expectsDbAuth: true
};

describe('function health verdicts', () => {
  it('is healthy after an invocation that logged the IAM login', () => {
    expect(health.evaluateFunctionHealth(quiet).status).toBe('healthy');
  });

  it('waits for an invocation or for the login line', () => {
    expect(
      health.evaluateFunctionHealth({ ...quiet, invocations: 0, authLines: [] })
    ).toEqual({
      status: 'pending',
      findings: [],
      note: 'not invoked since deploy'
    });
    expect(
      health.evaluateFunctionHealth({ ...quiet, authLines: [] }).note
    ).toBe('no [AUTH IAM] login line yet');
    expect(
      health.evaluateFunctionHealth({
        ...quiet,
        authLines: [],
        expectsDbAuth: false
      }).status
    ).toBe('healthy');
  });

  it.each([
    'Error: Access denied for user lambda',
    'Runtime.ImportModuleError: Error: Cannot find module mysql2'
  ])('fails on the log line %s', (line) => {
    const verdict = health.evaluateFunctionHealth({
      ...quiet,
      badLines: [line]
    });
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.findings[0]).toContain(line.slice(0, 20));
  });

  it('fails when the database login falls back to a password', () => {
    expect(
      health.evaluateFunctionHealth({
        ...quiet,
        authLines: ['[AUTH PASSWORD]']
      }).findings
    ).toEqual(['database login used [AUTH PASSWORD], expected [AUTH IAM]']);
  });

  it('fails on new Lambda errors relative to the previous day', () => {
    expect(health.evaluateFunctionHealth({ ...quiet, errors: 1 }).status).toBe(
      'unhealthy'
    );
    const noisy = { ...quiet, baselineErrors: 10, baselineInvocations: 100 };
    expect(
      health.evaluateFunctionHealth({ ...noisy, errors: 1, invocations: 5 })
        .status
    ).toBe('healthy');
    expect(
      health.evaluateFunctionHealth({ ...noisy, errors: 3, invocations: 5 })
        .status
    ).toBe('unhealthy');
  });

  it('combines functions: unhealthy wins, then pending', () => {
    const verdicts = [
      { functionName: 'a', status: 'healthy', findings: [], note: null },
      {
        functionName: 'b',
        status: 'pending',
        findings: [],
        note: 'not invoked since deploy'
      }
    ];
    expect(health.combineVerdicts(verdicts)).toEqual({
      status: 'pending',
      findings: [],
      note: 'b: not invoked since deploy'
    });
    expect(
      health.combineVerdicts([
        ...verdicts,
        {
          functionName: 'c',
          status: 'unhealthy',
          findings: ['boom'],
          note: null
        }
      ])
    ).toEqual({ status: 'unhealthy', findings: ['c: boom'], note: null });
  });
});

describe('health checker', () => {
  const item = {
    service: 'teamLoop',
    region: 'us-east-1',
    verification_targets: ['teamLoop'],
    validation_profile: 'lambda-version',
    expects_db_auth: true
  };

  function fakeAws(responses: Record<string, unknown>) {
    const calls: string[][] = [];
    return {
      calls,
      json: async (args: string[]) => {
        calls.push(args);
        const metric = args[args.indexOf('--metric-name') + 1];
        const period = args[args.indexOf('--period') + 1];
        if (args[0] === 'cloudwatch') {
          return responses[`${metric}:${period}`] ?? { Datapoints: [] };
        }
        const pattern = args[args.indexOf('--filter-pattern') + 1];
        return responses[pattern] ?? { events: [] };
      }
    };
  }

  it('reads metrics since the deploy and the previous day, plus log lines', async () => {
    const aws = fakeAws({
      'Invocations:60': { Datapoints: [{ Sum: 2 }, { Sum: 1 }] },
      'Invocations:3600': { Datapoints: [{ Sum: 40 }] },
      [health.AUTH_LOG_PATTERN]: { events: [{ message: '[AUTH IAM]' }] }
    });
    const checker = health.createHealthChecker({
      aws,
      environment: 'prod',
      now: () => Date.parse('2026-11-24T10:05:00Z')
    });
    const verdict = await checker.check(
      item,
      Date.parse('2026-11-24T10:00:00Z')
    );
    expect(verdict.status).toBe('healthy');
    const metricCall = aws.calls.find(
      (args) => args[0] === 'cloudwatch' && args.indexOf('60') !== -1
    )!;
    expect(metricCall).toEqual(
      expect.arrayContaining([
        '--region',
        'us-east-1',
        'Name=FunctionName,Value=teamLoop',
        '2026-11-24T10:00:00.000Z',
        '2026-11-24T10:05:00.000Z'
      ])
    );
    expect(
      aws.calls.some((args) => args.indexOf('/aws/lambda/teamLoop') !== -1)
    ).toBe(true);
  });

  it('skips resource-only stacks and Lambda@Edge', async () => {
    const checker = health.createHealthChecker({
      aws: fakeAws({}),
      environment: 'prod'
    });
    for (const profile of ['cloudformation-stack', 'lambda-edge-association']) {
      expect(
        (await checker.check({ ...item, validation_profile: profile }, 0))
          .status
      ).toBe('skipped');
    }
  });
});

describe('AWS CLI through GitHub OIDC', () => {
  it('assumes the role from a refreshed web-identity token file', async () => {
    let time = 0;
    const runs: { args: string[]; env: Record<string, string> }[] = [];
    const tokenFetches: string[] = [];
    const aws = health.createAwsCli({
      roleArn: 'arn:aws:iam::123456789012:role/deploy',
      sessionName: 'deploy-train-1',
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req?x=1',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
        AWS_ACCESS_KEY_ID: 'static',
        PATH: 'bin'
      },
      now: () => time,
      fetchImpl: async (url: string) => {
        tokenFetches.push(url);
        return {
          ok: true,
          json: async () => ({ value: `jwt-${tokenFetches.length}` })
        };
      },
      run: async (
        _command: string,
        args: string[],
        env: Record<string, string>
      ) => {
        runs.push({ args, env });
        expect(readFileSync(env.AWS_WEB_IDENTITY_TOKEN_FILE, 'utf8')).toBe(
          `jwt-${tokenFetches.length}`
        );
        return { code: 0, stdout: '{"ok":true}', stderr: '' };
      }
    });
    expect(await aws.json(['lambda', 'get-function'])).toEqual({ ok: true });
    time = 60_000;
    await aws.json(['lambda', 'get-function']);
    time = 5 * 60_000;
    await aws.json(['lambda', 'get-function']);
    expect(tokenFetches).toHaveLength(2);
    expect(tokenFetches[0]).toContain('audience=sts.amazonaws.com');
    expect(runs[0].env.AWS_ROLE_ARN).toBe(
      'arn:aws:iam::123456789012:role/deploy'
    );
    expect(runs[0].env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(runs[0].args.slice(-2)).toEqual(['--output', 'json']);
    const tokenFile = runs[0].env.AWS_WEB_IDENTITY_TOKEN_FILE;
    aws.cleanup();
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('treats a missing log group as no events and other failures as errors', async () => {
    let stderr = 'An error occurred (ResourceNotFoundException)';
    const aws = health.createAwsCli({
      roleArn: 'arn:aws:iam::123456789012:role/deploy',
      sessionName: 's',
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req?x=1',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't'
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ value: 'jwt' })
      }),
      run: async () => ({ code: 254, stdout: '', stderr })
    });
    expect(
      await aws.json(['logs', 'filter-log-events'], { allowMissing: true })
    ).toBeNull();
    stderr = 'AccessDenied';
    await expect(
      aws.json(['logs', 'filter-log-events'], { allowMissing: true })
    ).rejects.toThrow('AccessDenied');
    aws.cleanup();
  });

  it('requires GitHub OIDC', async () => {
    const aws = health.createAwsCli({
      roleArn: 'arn:aws:iam::123456789012:role/deploy',
      sessionName: 's',
      env: {}
    });
    await expect(aws.json(['sts', 'get-caller-identity'])).rejects.toThrow(
      'id-token: write'
    );
    aws.cleanup();
  });
});
