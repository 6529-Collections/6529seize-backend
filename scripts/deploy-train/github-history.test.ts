const github = require('./github');
const report = require('./report');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-23T12:00:00Z');

function run(
  id: number,
  title: string,
  startedAt: string,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    display_title: title,
    head_branch: 'main',
    conclusion: 'success',
    head_sha: `${id}${'0'.repeat(40)}`.slice(0, 40),
    run_started_at: startedAt,
    created_at: startedAt,
    updated_at: startedAt,
    html_url: `https://example.test/runs/${id}`,
    triggering_actor: { login: 'dev' },
    ...extra
  };
}

function historyClient(
  runs: ReturnType<typeof run>[],
  forcedTotal?: (range: string) => number
) {
  const queries: Record<string, string>[] = [];
  return {
    queries,
    async listWorkflowRuns(_workflow: string, params: Record<string, string>) {
      queries.push(params);
      const [from, to] = params.created
        .split('..')
        .map((value) => Date.parse(value));
      const matching = runs.filter((entry) => {
        const created = Date.parse(entry.created_at);
        return created >= from && created <= to;
      });
      const page = Number(params.page);
      return {
        total_count: forcedTotal
          ? forcedTotal(params.created)
          : matching.length,
        workflow_runs: matching.slice((page - 1) * 100, page * 100)
      };
    }
  };
}

describe('deployed commit history', () => {
  it('takes the newest successful prod deploy of each service', async () => {
    const client = historyClient([
      run(1, 'Deploy teamLoop to prod', '2026-11-20T10:00:00Z'),
      run(2, 'Deploy teamLoop to prod', '2026-11-22T10:00:00Z', {
        conclusion: 'failure'
      }),
      run(3, 'Deploy teamLoop to staging', '2026-11-22T11:00:00Z'),
      run(4, 'Deploy nftsLoop to prod', '2026-11-21T10:00:00Z', {
        head_branch: 'other'
      }),
      run(5, 'Deploy nftsLoop to prod', '2026-09-01T10:00:00Z'),
      run(6, 'Deploy api to prod', '2026-11-23T09:00:00Z', { conclusion: null })
    ]);
    const found = await github.findDeployedCommits({
      client,
      environment: 'prod',
      services: ['teamLoop', 'nftsLoop', 'api'],
      now: NOW,
      historyStart: NOW - 120 * DAY
    });
    expect(found.get('teamLoop').run_id).toBe(1);
    expect(found.get('nftsLoop').run_id).toBe(5);
    expect(found.has('api')).toBe(false);
    for (const params of client.queries) {
      expect(params.status).toBeUndefined();
      expect(params.branch).toBe('main');
      expect(params.event).toBe('workflow_dispatch');
    }
  });

  it('stops reading history once every service is found', async () => {
    const client = historyClient([
      run(1, 'Deploy teamLoop to prod', '2026-11-20T10:00:00Z')
    ]);
    await github.findDeployedCommits({
      client,
      environment: 'prod',
      services: ['teamLoop'],
      now: NOW,
      historyStart: NOW - 365 * DAY
    });
    expect(client.queries).toHaveLength(1);
  });

  it('splits a window that exceeds the 1000-result search limit', async () => {
    const client = historyClient(
      [run(1, 'Deploy teamLoop to prod', '2026-11-20T10:00:00Z')],
      (range) =>
        Date.parse(range.split('..')[1]) - Date.parse(range.split('..')[0]) >
        10 * DAY
          ? 1500
          : 1
    );
    const found = await github.findDeployedCommits({
      client,
      environment: 'staging',
      services: ['teamLoop'],
      now: NOW,
      historyStart: NOW - 30 * DAY
    });
    expect(client.queries.length).toBeGreaterThan(2);
    expect(client.queries[0].branch).toBe('1a-staging');
    expect(found.size).toBe(0);
  });
});

describe('train halts', () => {
  function client(runs: any[], jobs: Record<number, any[]>) {
    return {
      async listWorkflowRuns() {
        return { workflow_runs: runs };
      },
      async listRunJobs(id: number) {
        return jobs[id] ?? [];
      }
    };
  }
  const trainRun = (
    id: number,
    created: string,
    conclusion: string,
    title = 'Deploy train'
  ) => ({
    id,
    created_at: created,
    status: 'completed',
    conclusion,
    display_title: title,
    html_url: `https://example.test/runs/${id}`
  });

  it('finds a halt left by a failed ship job', async () => {
    const halt = await github.findUnclearedHalt(
      client(
        [
          trainRun(3, '2026-11-23T10:00:00Z', 'success'),
          trainRun(2, '2026-11-23T09:00:00Z', 'failure')
        ],
        {
          2: [
            { name: 'Plan', conclusion: 'success' },
            { name: 'Ship', conclusion: 'failure' }
          ]
        }
      ),
      { currentRunId: 4, shipJobName: 'Ship' }
    );
    expect(halt).toMatchObject({ run_id: 2 });
  });

  it('ignores planning failures and runs cleared by a later resume', async () => {
    expect(
      await github.findUnclearedHalt(
        client([trainRun(2, '2026-11-23T09:00:00Z', 'failure')], {
          2: [{ name: 'Plan', conclusion: 'failure' }]
        }),
        { currentRunId: 4, shipJobName: 'Ship' }
      )
    ).toBeNull();
    expect(
      await github.findUnclearedHalt(
        client(
          [
            trainRun(
              3,
              '2026-11-23T10:00:00Z',
              'success',
              'Deploy train (resume)'
            ),
            trainRun(2, '2026-11-23T09:00:00Z', 'failure')
          ],
          { 2: [{ name: 'Ship', conclusion: 'failure' }] }
        ),
        { currentRunId: 4, shipJobName: 'Ship' }
      )
    ).toBeNull();
  });
});

describe('GitHub client', () => {
  function response(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === null ? '' : JSON.stringify(body))
    };
  }

  it('retries reads on server errors but never retries writes', async () => {
    const calls: string[] = [];
    let failures = 1;
    const client = github.createGitHubClient({
      token: 't',
      repository: 'owner/repo',
      sleep: async () => undefined,
      fetchImpl: async (url: string, init: { method: string }) => {
        calls.push(`${init.method} ${url}`);
        if (failures > 0) {
          failures -= 1;
          return response(502, { message: 'bad gateway' });
        }
        return response(200, { object: { sha: 'abc' } });
      }
    });
    expect(await client.getBranchSha('main')).toBe('abc');
    expect(calls).toEqual([
      'GET https://api.github.com/repos/owner/repo/git/ref/heads/main',
      'GET https://api.github.com/repos/owner/repo/git/ref/heads/main'
    ]);
    failures = 1;
    await expect(client.request('POST', '/x', {})).rejects.toThrow('502');
  });

  it('asks GitHub for the dispatched run ID and falls back on older APIs', async () => {
    const bodies: any[] = [];
    let modern = true;
    const client = github.createGitHubClient({
      token: 't',
      repository: 'owner/repo',
      fetchImpl: async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (modern) return response(200, { workflow_run_id: 77 });
        return body.return_run_details
          ? response(422, { message: 'Invalid request: return_run_details' })
          : response(204, null);
      }
    });
    expect(
      await client.dispatchWorkflow('deploy.yml', 'main', { service: 'api' })
    ).toBe(77);
    modern = false;
    expect(
      await client.dispatchWorkflow('deploy.yml', 'main', { service: 'api' })
    ).toBeNull();
    expect(bodies[2]).toEqual({ ref: 'main', inputs: { service: 'api' } });
  });

  it('does not re-dispatch after any other 422', async () => {
    let calls = 0;
    const client = github.createGitHubClient({
      token: 't',
      repository: 'owner/repo',
      fetchImpl: async () => {
        calls += 1;
        return response(422, { message: 'Unexpected inputs provided' });
      }
    });
    await expect(
      client.dispatchWorkflow('deploy.yml', 'main', { service: 'api' })
    ).rejects.toThrow('Unexpected inputs');
    expect(calls).toBe(1);
  });

  it('rejects a missing token or malformed repository', () => {
    expect(() =>
      github.createGitHubClient({ token: '', repository: 'a/b' })
    ).toThrow('token');
    expect(() =>
      github.createGitHubClient({ token: 't', repository: 'nope' })
    ).toThrow('owner/name');
  });
});

describe('persistent halts', () => {
  type Issue = {
    number: number;
    title: string;
    state: string;
    html_url: string;
    labels: { name: string }[];
    pull_request?: unknown;
  };

  /** A tiny in-memory GitHub: issues, labels and a long run history. */
  function fakeGitHub(issues: Issue[], runCount = 0) {
    const requests: string[] = [];
    const labels = new Set<string>();
    const runs = Array.from({ length: runCount }, (_, index) => ({
      id: 1000 + index,
      created_at: new Date(
        Date.UTC(2026, 10, 23, 12) + index * 60_000
      ).toISOString(),
      status: 'completed',
      conclusion: 'success',
      display_title: 'Deploy train',
      html_url: `https://example.test/runs/${1000 + index}`
    }));
    const client = {
      async request(method: string, path: string, body?: any) {
        requests.push(`${method} ${path}`);
        if (method === 'GET' && path.startsWith('/issues?')) {
          const label = /labels=([^&]+)/.exec(path)![1];
          return issues.filter((issue) =>
            issue.labels.some((entry) => entry.name === label)
          );
        }
        if (method === 'POST' && path === '/labels') {
          if (labels.has(body.name)) {
            throw Object.assign(new Error('exists'), { status: 422 });
          }
          labels.add(body.name);
          return {};
        }
        if (method === 'POST' && path === '/issues') {
          const issue = {
            number: issues.length + 1,
            title: body.title,
            state: 'open',
            html_url: `https://example.test/issues/${issues.length + 1}`,
            labels: body.labels.map((name: string) => ({ name }))
          };
          issues.push(issue);
          return issue;
        }
        const number = Number(/\/issues\/(\d+)/.exec(path)![1]);
        const issue = issues.find((entry) => entry.number === number)!;
        if (path.endsWith('/labels')) {
          issue.labels.push(...body.labels.map((name: string) => ({ name })));
        } else if (method === 'PATCH') {
          issue.state = body.state;
        }
        return {};
      },
      async listWorkflowRuns() {
        return { workflow_runs: runs.slice(-50).reverse() };
      },
      async listRunJobs() {
        return [];
      }
    };
    return { client, requests, issues };
  }

  const shipJob = { currentRunId: 1, shipJobName: 'Ship' };

  it('stays halted however many train runs follow the halt', async () => {
    // The halted run fell off the run-history page long ago; the issue
    // still holds the train.
    const { client } = fakeGitHub([], 500);
    await github.recordHalt(client, {
      title: 'Deploy train halted at api',
      body: 'x'
    });
    expect(await github.currentHalt(client, shipJob)).toEqual({
      url: 'https://example.test/issues/1',
      label: 'issue #1'
    });
  });

  it('is not cleared by closing the issue by hand', async () => {
    const { client, issues } = fakeGitHub([]);
    await github.recordHalt(client, { title: 't', body: 'b' });
    issues[0].state = 'closed';
    expect((await github.currentHalt(client, shipJob)).label).toBe('issue #1');
  });

  it('clears only through a resume, which labels, comments on and closes the issue', async () => {
    const { client, requests, issues } = fakeGitHub([]);
    await github.recordHalt(client, { title: 't', body: 'b' });
    const cleared = await github.resumeHalts(client, {
      by: 'dev',
      runUrl: 'https://example.test/runs/9'
    });
    expect(cleared.map((halt: { number: number }) => halt.number)).toEqual([1]);
    expect(issues[0].state).toBe('closed');
    expect(issues[0].labels.map((label) => label.name)).toEqual([
      github.HALT_LABEL,
      github.RESUMED_LABEL
    ]);
    expect(requests).toContain('POST /issues/1/comments');
    expect(await github.currentHalt(client, shipJob)).toBeNull();
    expect(
      await github.resumeHalts(client, { by: 'dev', runUrl: 'u' })
    ).toEqual([]);
  });

  it('ignores pull requests that carry the label', async () => {
    const { client } = fakeGitHub([
      {
        number: 7,
        title: 'pr',
        state: 'open',
        html_url: 'u',
        labels: [{ name: github.HALT_LABEL }],
        pull_request: {}
      }
    ]);
    expect(await github.findHaltIssues(client)).toEqual([]);
  });

  it('refuses to ship a plan from an earlier attempt or after a halt', async () => {
    const { staleShipReason } = require('./cli');
    const previous = process.env.GITHUB_RUN_ATTEMPT;
    process.env.GITHUB_RUN_ATTEMPT = '2';
    try {
      const { client } = fakeGitHub([]);
      expect(await staleShipReason({ run_attempt: '1' }, client)).toContain(
        'run attempt 1, not 2'
      );
      expect(await staleShipReason({ run_attempt: '2' }, client)).toBeNull();
      await github.recordHalt(client, { title: 't', body: 'b' });
      expect(await staleShipReason({ run_attempt: '2' }, client)).toContain(
        'halted (issue #1)'
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
      else process.env.GITHUB_RUN_ATTEMPT = previous;
    }
  });

  it('describes the halt and how to resume in the issue', () => {
    const issue = report.haltIssue(
      { target_sha: 'f'.repeat(40) },
      {
        stop: {
          reason: 'unhealthy',
          halt: true,
          service: 'api',
          detail: 'api: new build logged "Cannot find module"'
        },
        shipped: [
          { service: 'dbMigrationsLoop', health: 'healthy', note: null }
        ],
        not_started: ['nftsLoop']
      },
      'https://example.test/runs/5'
    );
    expect(issue.title).toBe('Deploy train halted at api (ffffffffff)');
    expect(issue.body).toContain(
      '**health check failed**: api: new build logged'
    );
    expect(issue.body).toContain('Not started: nftsLoop');
    expect(issue.body).toContain('resume=true');
    expect(report.haltIssue(null, null, 'u').title).toBe(
      'Deploy train halted at start (none)'
    );
  });
});
