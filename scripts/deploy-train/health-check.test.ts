import { existsSync, readFileSync } from 'node:fs';

const health = require('./health');

const newBuild = {
  updateStatus: 'Successful',
  newInvocations: 2,
  invocations: 3,
  errors: 0,
  baselineInvocations: 100,
  baselineErrors: 0,
  badLines: [] as string[],
  authLines: ['[DB HOST x] [AUTH IAM] [SYNC ENTITIES false]'],
  expectsDbAuth: true
};

describe('function health verdicts', () => {
  it('is healthy once the new build ran and logged the IAM login', () => {
    expect(health.evaluateFunctionHealth(newBuild)).toEqual({
      status: 'healthy',
      findings: [],
      note: '2 invocation(s) of the new build'
    });
  });

  it('does not count traffic served by the old build', () => {
    // CloudWatch shows invocations, but none came from the new build's log
    // streams: the deploy is not verified yet.
    expect(
      health.evaluateFunctionHealth({
        ...newBuild,
        newInvocations: 0,
        invocations: 5,
        authLines: []
      })
    ).toEqual({
      status: 'pending',
      findings: [],
      note: 'new build not invoked yet'
    });
    expect(
      health.evaluateFunctionHealth({ ...newBuild, authLines: [] }).note
    ).toBe('no [AUTH IAM] login line from the new build yet');
    expect(
      health.evaluateFunctionHealth({
        ...newBuild,
        authLines: [],
        expectsDbAuth: false
      }).status
    ).toBe('healthy');
  });

  it.each([
    'Error: Access denied for user lambda',
    'Runtime.ImportModuleError: Error: Cannot find module mysql2',
    'INIT_REPORT Init Duration: 9999 ms Phase: init Status: error'
  ])('halts immediately on the startup or login failure %s', (line) => {
    const verdict = health.evaluateFunctionHealth({
      ...newBuild,
      newInvocations: 0,
      badLines: [line]
    });
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.findings[0]).toContain(line.slice(0, 20));
  });

  it('halts when the new build logs in with a password', () => {
    expect(
      health.evaluateFunctionHealth({
        ...newBuild,
        authLines: ['[AUTH PASSWORD]']
      }).findings
    ).toEqual([
      "new build's database login used [AUTH PASSWORD], expected [AUTH IAM]"
    ]);
  });

  it('follows the Lambda update status', () => {
    expect(
      health.evaluateFunctionHealth({ ...newBuild, updateStatus: 'Failed' })
        .status
    ).toBe('unhealthy');
    expect(
      health.evaluateFunctionHealth({ ...newBuild, updateStatus: 'InProgress' })
    ).toEqual({
      status: 'pending',
      findings: [],
      note: 'Lambda update in progress'
    });
  });

  it('needs repeated errors, and a clear increase over a noisy baseline', () => {
    const status = (overrides: Record<string, unknown>) =>
      health.evaluateFunctionHealth({ ...newBuild, ...overrides }).status;
    expect(status({ errors: 2 })).toBe('healthy');
    expect(status({ errors: 3 })).toBe('unhealthy');
    const noisy = { baselineErrors: 10, baselineInvocations: 100 };
    expect(status({ ...noisy, errors: 3, invocations: 20 })).toBe('healthy');
    expect(status({ ...noisy, errors: 4, invocations: 20 })).toBe('unhealthy');
    expect(
      status({
        errors: 3,
        thresholds: { minErrors: 5, rateFactor: 2 }
      })
    ).toBe('healthy');
    expect(health.DEFAULT_ERROR_THRESHOLDS).toEqual({
      minErrors: 3,
      rateFactor: 2
    });
  });

  it('combines functions: unhealthy wins, then pending', () => {
    const verdicts = [
      { functionName: 'a', status: 'healthy', findings: [], note: null },
      {
        functionName: 'b',
        status: 'pending',
        findings: [],
        note: 'new build not invoked yet'
      }
    ];
    expect(health.combineVerdicts(verdicts)).toEqual({
      status: 'pending',
      findings: [],
      note: 'b: new build not invoked yet'
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

  it('parses Lambda LastModified timestamps', () => {
    expect(health.parseLambdaTime('2026-11-24T10:02:00.000+0000')).toBe(
      Date.parse('2026-11-24T10:02:00Z')
    );
    expect(Number.isNaN(health.parseLambdaTime(undefined))).toBe(true);
  });
});

describe('health checker', () => {
  const DEPLOY_STARTED = Date.parse('2026-11-24T10:00:00Z');
  const LIVE_AT = Date.parse('2026-11-24T10:02:00Z');
  const item = {
    service: 'teamLoop',
    region: 'us-east-1',
    verification_targets: ['teamLoop'],
    validation_profile: 'lambda-version',
    expects_db_auth: true
  };

  // `at` defaults to a minute after the new build went live.
  type Event = { stream: string; message: string; at?: number };

  function fakeAws({
    lastModified = '2026-11-24T10:02:00.000+0000',
    streams = [] as { logStreamName: string; creationTime: number }[],
    events = [] as Event[],
    metrics = {} as Record<string, number>,
    points = [] as { key: string; at: string; sum: number }[]
  }) {
    const calls: string[][] = [];
    const value = (args: string[], flag: string) =>
      args[args.indexOf(flag) + 1];
    const matches = (pattern: string, message: string) => {
      if (pattern === health.INVOCATION_LOG_PATTERN) {
        return message.startsWith('REPORT RequestId');
      }
      if (pattern.startsWith('"AUTH ')) {
        return message.includes(pattern.slice(1, -1));
      }
      return /Access denied|Cannot find module|Status: error/.test(message);
    };
    return {
      calls,
      json: async (args: string[]) => {
        calls.push(args);
        if (args[1] === 'get-function-configuration') {
          return {
            LastModified: lastModified,
            LastUpdateStatus: 'Successful',
            CodeSha256: 'new-sha'
          };
        }
        if (args[0] === 'cloudwatch') {
          const key = `${value(args, '--metric-name')}:${value(args, '--period')}`;
          // Datapoints with a timestamp count only inside the queried range.
          const start = Date.parse(value(args, '--start-time'));
          const finish = Date.parse(value(args, '--end-time'));
          const timed = points
            .filter((point) => point.key === key)
            .filter((point) => {
              const at = Date.parse(point.at);
              return at >= start && at < finish;
            })
            .map((point) => ({ Sum: point.sum }));
          return { Datapoints: [{ Sum: metrics[key] ?? 0 }, ...timed] };
        }
        if (args[1] === 'describe-log-streams') return { logStreams: streams };
        const start = args.indexOf('--log-stream-names') + 1;
        const end = args.indexOf('--start-time');
        const requested = args.slice(start, end);
        const pattern = value(args, '--filter-pattern');
        const from = Number(value(args, '--start-time'));
        const to = Number(value(args, '--end-time'));
        return {
          events: events
            .filter((event) => requested.indexOf(event.stream) !== -1)
            .filter((event) => {
              const at = event.at ?? LIVE_AT + 60_000;
              return at >= from && at <= to;
            })
            .filter((event) => matches(pattern, event.message))
            .slice(0, Number(value(args, '--max-items')))
            .map((event) => ({ message: event.message }))
        };
      }
    };
  }

  const oldStream = {
    logStreamName: 'old',
    creationTime: DEPLOY_STARTED - 3600_000
  };
  const newStream = { logStreamName: 'new', creationTime: LIVE_AT + 30_000 };

  function checker(aws: ReturnType<typeof fakeAws>) {
    return health.createHealthChecker({
      aws,
      environment: 'prod',
      now: () => Date.parse('2026-11-24T10:05:00Z')
    });
  }

  it('reports old-build traffic as not yet verified', async () => {
    // Reproduces the bug: the old build kept handling invocations after
    // the deploy started, and none of them came from the new build.
    const aws = fakeAws({
      streams: [oldStream],
      events: [
        { stream: 'old', message: 'REPORT RequestId: 1 Duration: 5 ms' },
        { stream: 'old', message: '[AUTH IAM]' }
      ],
      metrics: { 'Invocations:60': 4 }
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.status).toBe('pending');
    expect(verdict.note).toBe('teamLoop: new build not invoked yet');
    // Only streams created after the new build went live are read.
    expect(aws.calls.some((args) => args[1] === 'filter-log-events')).toBe(
      false
    );
  });

  it('starts the window when the new build went live and reads only its streams', async () => {
    const aws = fakeAws({
      streams: [oldStream, newStream],
      events: [
        { stream: 'old', message: 'Error: Access denied for user x' },
        { stream: 'new', message: 'REPORT RequestId: 2 Duration: 5 ms' },
        { stream: 'new', message: '[DB HOST h] [AUTH IAM]' }
      ],
      metrics: { 'Invocations:60': 1 }
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.status).toBe('healthy');
    const metricCall = aws.calls.find(
      (args) => args[0] === 'cloudwatch' && args.indexOf('60') !== -1
    )!;
    expect(metricCall).toEqual(
      expect.arrayContaining([
        'Name=FunctionName,Value=teamLoop',
        '2026-11-24T10:02:00.000Z',
        '2026-11-24T10:05:00.000Z'
      ])
    );
    for (const args of aws.calls.filter(
      (call) => call[1] === 'filter-log-events'
    )) {
      expect(args).toContain('new');
      expect(args).not.toContain('old');
    }
  });

  it('finds a password login even after many IAM logins', async () => {
    const aws = fakeAws({
      streams: [newStream],
      events: [
        { stream: 'new', message: 'REPORT RequestId: 3 Duration: 5 ms' },
        ...Array.from({ length: 60 }, () => ({
          stream: 'new',
          message: '[DB HOST h] [AUTH IAM]'
        })),
        { stream: 'new', message: '[DB HOST h] [AUTH PASSWORD]' }
      ]
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.findings[0]).toContain('[AUTH PASSWORD]');
  });

  it('counts errors in the minute the new build went live', async () => {
    // GelatoGenesis's case: go-live at 10:02:30 and three Lambda errors
    // right after, all in the 10:02 one-minute bucket.
    const aws = fakeAws({
      lastModified: '2026-11-24T10:02:30.000+0000',
      streams: [newStream],
      events: [
        { stream: 'new', message: 'REPORT RequestId: 4 Duration: 5 ms' }
      ],
      points: [
        { key: 'Errors:60', at: '2026-11-24T10:02:00Z', sum: 3 },
        { key: 'Invocations:60', at: '2026-11-24T10:02:00Z', sum: 3 }
      ]
    });
    const verdict = await checker(aws).check(
      { ...item, expects_db_auth: false },
      DEPLOY_STARTED
    );
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.findings[0]).toContain('3 Lambda errors');
    const errorCall = aws.calls.find(
      (args) =>
        args[0] === 'cloudwatch' &&
        args.indexOf('Errors') !== -1 &&
        args.indexOf('60') !== -1
    )!;
    expect(errorCall).toContain('2026-11-24T10:02:00.000Z');
  });

  it('halts on a startup failure in the new build', async () => {
    const aws = fakeAws({
      streams: [newStream],
      events: [
        {
          stream: 'new',
          message: 'Runtime.ImportModuleError: Cannot find module x'
        }
      ]
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.status).toBe('unhealthy');
  });

  it('says when the deploy left the function unchanged', async () => {
    const aws = fakeAws({ lastModified: '2026-11-20T10:00:00.000+0000' });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.note).toBe(
      'teamLoop: new build not invoked yet; this deploy did not change the function'
    );
  });

  it('never reports an unchanged function as a verified new build', async () => {
    // The existing code cold-starts and logs in normally after the deploy.
    const aws = fakeAws({
      lastModified: '2026-11-20T10:00:00.000+0000',
      streams: [{ logStreamName: 'cold', creationTime: DEPLOY_STARTED + 1 }],
      events: [
        { stream: 'cold', message: 'REPORT RequestId: 3 Duration: 5 ms' },
        { stream: 'cold', message: '[AUTH IAM]' }
      ]
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.status).toBe('pending');
    expect(verdict.note).toBe(
      'teamLoop: its existing code ran normally; this deploy did not change the function'
    );
  });

  it('ignores failures logged after the observation window closed', async () => {
    const windowEnd = LIVE_AT + 120_000;
    const aws = fakeAws({
      streams: [newStream],
      events: [
        { stream: 'new', message: 'REPORT RequestId: 4 Duration: 5 ms' },
        { stream: 'new', message: '[AUTH IAM]' },
        {
          stream: 'new',
          message: 'Error: Access denied for user x',
          at: windowEnd + 60_000
        }
      ]
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED, windowEnd);
    expect(verdict.status).toBe('healthy');
    const inside = await checker(aws).check(item, DEPLOY_STARTED);
    expect(inside.status).toBe('unhealthy');
  });

  it('reads every new stream, a hundred per query', async () => {
    // The failing environment is the least recently active of 150.
    const streams = Array.from({ length: 150 }, (_, index) => ({
      logStreamName: `s${index}`,
      creationTime: LIVE_AT + 1000 + index
    }));
    const aws = fakeAws({
      streams,
      events: [
        { stream: 's0', message: 'REPORT RequestId: 5 Duration: 5 ms' },
        { stream: 's0', message: '[AUTH IAM]' },
        {
          stream: 's149',
          message: 'Runtime.ImportModuleError: Cannot find module y'
        }
      ]
    });
    const verdict = await checker(aws).check(item, DEPLOY_STARTED);
    expect(verdict.status).toBe('unhealthy');
    const describe = aws.calls.find(
      (args) => args[1] === 'describe-log-streams'
    )!;
    expect(describe[describe.indexOf('--max-items') + 1]).toBe('500');
    const filterCalls = aws.calls.filter(
      (args) => args[1] === 'filter-log-events'
    );
    for (const args of filterCalls) {
      const names = args.slice(
        args.indexOf('--log-stream-names') + 1,
        args.indexOf('--start-time')
      );
      expect(names.length).toBeLessThanOrEqual(100);
    }
  });

  it('skips resource-only stacks and Lambda@Edge', async () => {
    const check = checker(fakeAws({}));
    for (const profile of ['cloudformation-stack', 'lambda-edge-association']) {
      expect(
        (await check.check({ ...item, validation_profile: profile }, 0)).status
      ).toBe('skipped');
    }
  });
});

describe('release-note event confirmation', () => {
  it('looks for the line the release-notes loop logs for each recorded event', () => {
    // The loop's own log statement: if it changes, so must the pattern.
    const loop = readFileSync(
      `${__dirname}/../../src/releaseNotesGenerationLoop/index.ts`,
      'utf8'
    );
    expect(loop).toContain(
      '`Recorded release group pr-${request.pull_request_number} event for ${service} run ${request.run_id}`'
    );
    expect(health.RELEASE_NOTE_EVENT_PREFIX).toBe('Recorded release group');
    expect(
      health.releaseNoteEventPattern({
        pull: 2574,
        service: 'teamLoop',
        runId: 45238902874
      })
    ).toBe(
      '"Recorded release group pr-2574 event for teamLoop run 45238902874"'
    );
  });

  it('asks CloudWatch for one matching line since the group opened', async () => {
    const calls: string[][] = [];
    const checker = health.createHealthChecker({
      aws: {
        json: async (args: string[]) => {
          calls.push(args);
          return {
            events: [
              {
                message: 'Recorded release group pr-5 event for teamLoop run 7'
              }
            ]
          };
        }
      },
      environment: 'prod'
    });
    await expect(
      checker.releaseNoteSeen({
        region: 'us-east-1',
        functionName: 'releaseNotesGenerationLoop',
        pull: 5,
        service: 'teamLoop',
        runId: 7,
        since: 1000
      })
    ).resolves.toBe(true);
    expect(calls).toEqual([
      [
        'logs',
        'filter-log-events',
        '--region',
        'us-east-1',
        '--log-group-name',
        '/aws/lambda/releaseNotesGenerationLoop',
        '--start-time',
        '1000',
        '--filter-pattern',
        '"Recorded release group pr-5 event for teamLoop run 7"',
        '--max-items',
        '1'
      ]
    ]);
    await expect(
      checker.releaseNoteSeen({
        region: 'us-east-1',
        functionName: 'releaseNotesGenerationLoop',
        pull: 5,
        service: 'teamLoop',
        runId: '7 OR x',
        since: 1000
      })
    ).rejects.toThrow('not a release-note event');
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
