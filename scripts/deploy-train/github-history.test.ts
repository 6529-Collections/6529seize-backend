import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  function client(
    runs: any[],
    jobs: Record<number, any[]>,
    deploys: any[] | ((page: number) => any[]) = []
  ) {
    const jobReads: number[] = [];
    return {
      jobReads,
      async listWorkflowRuns(workflow: string, params: Record<string, string>) {
        if (workflow !== github.DEPLOY_WORKFLOW) return { workflow_runs: runs };
        const page = Number(params.page);
        return {
          workflow_runs:
            typeof deploys === 'function'
              ? deploys(page)
              : page === 1
                ? deploys
                : []
        };
      },
      async listRunJobs(id: number) {
        jobReads.push(id);
        return jobs[id] ?? [];
      }
    };
  }
  const prodDeploy = (id: number, created: string, service = 'api') => ({
    id,
    created_at: created,
    display_title: `Deploy ${service} to prod`
  });
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
          {
            2: [{ name: 'Ship', conclusion: 'failure' }],
            3: [{ name: 'Resume', conclusion: 'success' }]
          }
        ),
        { currentRunId: 4, shipJobName: 'Ship' }
      )
    ).toBeNull();
  });

  it('is not cleared by a resume run whose Resume job did not complete', async () => {
    // GelatoGenesis's case: a fresh resume dispatch cancelled before its
    // Resume job ran must not clear a halt that only the history records.
    for (const resumeJobs of [
      [{ name: 'Resume', conclusion: 'cancelled' }],
      [{ name: 'Resume', conclusion: 'skipped' }],
      []
    ]) {
      const halt = await github.findUnclearedHalt(
        client(
          [
            trainRun(
              3,
              '2026-11-23T10:00:00Z',
              'cancelled',
              'Deploy train (resume)'
            ),
            trainRun(2, '2026-11-23T09:00:00Z', 'failure')
          ],
          { 2: [{ name: 'Ship', conclusion: 'failure' }], 3: resumeJobs }
        ),
        { currentRunId: 4, shipJobName: 'Ship' }
      );
      expect(halt).toMatchObject({ run_id: 2 });
    }
  });

  it('keeps a halt opened after a completed resume', async () => {
    const halt = await github.findUnclearedHalt(
      client(
        [
          trainRun(5, '2026-11-23T11:00:00Z', 'failure'),
          trainRun(
            3,
            '2026-11-23T10:00:00Z',
            'success',
            'Deploy train (resume)'
          ),
          trainRun(2, '2026-11-23T09:00:00Z', 'failure')
        ],
        {
          5: [{ name: 'Ship', conclusion: 'failure' }],
          2: [{ name: 'Ship', conclusion: 'failure' }],
          3: [{ name: 'Resume', conclusion: 'success' }]
        }
      ),
      { currentRunId: 6, shipJobName: 'Ship' }
    );
    expect(halt).toMatchObject({ run_id: 5 });
  });

  it('lets a resume run skip only the halts its own Resume job covered', async () => {
    const runs = [
      {
        ...trainRun(5, '2026-11-23T09:50:00Z', 'failure'),
        updated_at: '2026-11-23T10:20:00Z'
      },
      {
        ...trainRun(2, '2026-11-23T09:00:00Z', 'failure'),
        updated_at: '2026-11-23T09:30:00Z'
      }
    ];
    const jobs = {
      5: [
        {
          name: 'Ship',
          conclusion: 'failure',
          completed_at: '2026-11-23T10:20:00Z'
        }
      ],
      2: [
        {
          name: 'Ship',
          conclusion: 'failure',
          completed_at: '2026-11-23T09:30:00Z'
        }
      ]
    };
    // Dispatched at 10:00: covers run 2, not run 5, which failed later.
    expect(
      await github.findUnclearedHalt(client(runs, jobs), {
        currentRunId: 9,
        shipJobName: 'Ship',
        resumedAt: Date.parse('2026-11-23T10:00:00Z')
      })
    ).toMatchObject({ run_id: 5 });
    // Dispatched at 10:30: covers both.
    expect(
      await github.findUnclearedHalt(client(runs, jobs), {
        currentRunId: 9,
        shipJobName: 'Ship',
        resumedAt: Date.parse('2026-11-23T10:30:00Z')
      })
    ).toBeNull();
  });

  it('keeps a halt from a train that failed after the resume was dispatched', async () => {
    // The resume waits in the concurrency group behind a running train; if
    // that train then halts, its halt is newer than the resume.
    const halt = await github.findUnclearedHalt(
      client(
        [
          trainRun(
            3,
            '2026-11-23T10:00:00Z',
            'success',
            'Deploy train (resume)'
          ),
          {
            ...trainRun(2, '2026-11-23T09:50:00Z', 'failure'),
            updated_at: '2026-11-23T10:20:00Z'
          }
        ],
        {
          2: [
            {
              name: 'Ship',
              conclusion: 'failure',
              completed_at: '2026-11-23T10:20:00Z'
            }
          ],
          3: [{ name: 'Resume', conclusion: 'success' }]
        }
      ),
      { currentRunId: 4, shipJobName: 'Ship' }
    );
    expect(halt).toMatchObject({
      run_id: 2,
      failed_at: '2026-11-23T10:20:00Z'
    });
  });

  it('finds a halt behind a newer run that ended before the resume', async () => {
    // prxt's case: train 2 is shipping when train 3 queues and is replaced
    // at 10:05; the resume is dispatched at 10:10 and waits; train 2's Ship
    // then fails at 10:40. Run 3 ending before the resume must not end the
    // scan before run 2.
    const halt = await github.findUnclearedHalt(
      client(
        [
          trainRun(
            4,
            '2026-11-23T10:10:00Z',
            'success',
            'Deploy train (resume)'
          ),
          {
            ...trainRun(3, '2026-11-23T09:55:00Z', 'cancelled'),
            updated_at: '2026-11-23T10:05:00Z'
          },
          {
            ...trainRun(2, '2026-11-23T09:50:00Z', 'failure'),
            updated_at: '2026-11-23T10:40:00Z'
          }
        ],
        {
          2: [
            {
              name: 'Ship',
              conclusion: 'failure',
              completed_at: '2026-11-23T10:40:00Z'
            }
          ],
          4: [{ name: 'Resume', conclusion: 'success' }]
        }
      ),
      { currentRunId: 5, shipJobName: 'Ship' }
    );
    expect(halt).toMatchObject({
      run_id: 2,
      failed_at: '2026-11-23T10:40:00Z'
    });
  });

  it('stops reading once no older run could have been shipping at the resume', async () => {
    const c = client(
      [
        trainRun(9, '2026-11-23T10:00:00Z', 'success', 'Deploy train (resume)'),
        {
          ...trainRun(2, '2026-11-22T18:00:00Z', 'failure'),
          updated_at: '2026-11-22T18:30:00Z'
        }
      ],
      { 9: [{ name: 'Resume', conclusion: 'success' }] }
    );
    expect(
      await github.findUnclearedHalt(c, {
        currentRunId: 10,
        shipJobName: 'Ship'
      })
    ).toBeNull();
    // Run 2 was created 16 hours before the resume: never read.
    expect(c.jobReads).toEqual([9]);
  });

  describe('a cancelled Ship job without a halt issue', () => {
    const cancelledRun = (id: number) => ({
      ...trainRun(id, '2026-11-23T09:00:00Z', 'cancelled'),
      updated_at: '2026-11-23T10:00:00Z'
    });
    const cancelledShip = [
      { name: 'Plan', conclusion: 'success' },
      {
        name: 'Ship',
        conclusion: 'cancelled',
        started_at: '2026-11-23T09:10:00Z',
        completed_at: '2026-11-23T10:00:00Z'
      }
    ];

    it('halts once a prod deploy was dispatched while it ran', async () => {
      const halt = await github.findUnclearedHalt(
        client([cancelledRun(2)], { 2: cancelledShip }, [
          prodDeploy(70, '2026-11-23T09:30:00Z')
        ]),
        { currentRunId: 3, shipJobName: 'Ship' }
      );
      expect(halt).toMatchObject({
        run_id: 2,
        failed_at: '2026-11-23T10:00:00Z',
        cause: 'cancelled-after-dispatch'
      });
    });

    it('is cleared by a later completed resume like any halt', async () => {
      expect(
        await github.findUnclearedHalt(
          client(
            [
              trainRun(
                4,
                '2026-11-23T11:00:00Z',
                'success',
                'Deploy train (resume)'
              ),
              cancelledRun(2)
            ],
            {
              2: cancelledShip,
              4: [{ name: 'Resume', conclusion: 'success' }]
            },
            [prodDeploy(70, '2026-11-23T09:30:00Z')]
          ),
          { currentRunId: 5, shipJobName: 'Ship' }
        )
      ).toBeNull();
    });

    it('is a soft stop when nothing was dispatched while it ran', async () => {
      for (const deploys of [
        [],
        // Before the Ship job started (the previous train's), or a staging one.
        [
          prodDeploy(70, '2026-11-23T09:05:00Z'),
          {
            ...prodDeploy(71, '2026-11-23T09:30:00Z'),
            display_title: 'Deploy api to staging'
          }
        ]
      ]) {
        expect(
          await github.findUnclearedHalt(
            client([cancelledRun(2)], { 2: cancelledShip }, deploys),
            { currentRunId: 3, shipJobName: 'Ship' }
          )
        ).toBeNull();
      }
    });

    it('skips runs replaced while waiting without reading their jobs', async () => {
      const c = client(
        [
          {
            ...trainRun(2, '2026-11-23T09:00:00Z', 'cancelled'),
            updated_at: '2026-11-23T09:20:00Z'
          }
        ],
        {},
        [prodDeploy(70, '2026-11-23T09:30:00Z')]
      );
      expect(
        await github.findUnclearedHalt(c, {
          currentRunId: 3,
          shipJobName: 'Ship'
        })
      ).toBeNull();
      expect(c.jobReads).toEqual([]);
    });

    it('stays halted when the deploy history is too long to read', async () => {
      // Ten full pages of newer deploys: the Ship window is older than
      // anything read, so it counts as dispatched.
      const page = (n: number) =>
        Array.from({ length: 100 }, (_, i) =>
          prodDeploy(
            n * 1000 + i,
            new Date(
              Date.parse('2026-11-23T11:00:00Z') + (n * 100 + i) * 1000
            ).toISOString()
          )
        );
      const halt = await github.findUnclearedHalt(
        client([cancelledRun(2)], { 2: cancelledShip }, page),
        { currentRunId: 3, shipJobName: 'Ship' }
      );
      expect(halt).toMatchObject({
        run_id: 2,
        cause: 'cancelled-after-dispatch'
      });
    });
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
    created_at?: string;
    pull_request?: unknown;
    body?: string;
  };

  /**
   * A tiny in-memory GitHub: issues, labels, a long run history and one
   * resume run dispatched at RESUME_DISPATCHED. `now` stamps new issues.
   */
  function fakeGitHub(issues: Issue[], runCount = 0) {
    const requests: string[] = [];
    const labels = new Set<string>();
    const clock = { now: Date.parse('2026-11-24T09:00:00Z') };
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
            labels: body.labels.map((name: string) => ({ name })),
            created_at: new Date(clock.now).toISOString(),
            body: body.body
          };
          issues.push(issue);
          return issue;
        }
        const number = Number(/\/issues\/(\d+)/.exec(path)![1]);
        const issue = issues.find((entry) => entry.number === number)!;
        if (path.endsWith('/labels')) {
          issue.labels.push(...body.labels.map((name: string) => ({ name })));
        } else if (method === 'PATCH') {
          if (body.state) issue.state = body.state;
          if (body.body !== undefined) issue.body = body.body;
        }
        return {};
      },
      async listWorkflowRuns() {
        return { workflow_runs: runs.slice(-50).reverse() };
      },
      async listRunJobs() {
        return [];
      },
      async getRun(id: number) {
        // Re-run attempts keep the run's original created_at.
        return { id, created_at: RESUME_DISPATCHED, run_attempt: 2 };
      }
    };
    return { client, requests, issues, clock };
  }

  const shipJob = { currentRunId: 1, shipJobName: 'Ship' };
  const RESUME_DISPATCHED = '2026-11-24T10:00:00Z';
  const resumeRun = {
    by: 'dev',
    runUrl: 'https://example.test/runs/9',
    requestedBefore: Date.parse(RESUME_DISPATCHED)
  };

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
    const { cleared } = await github.resumeHalts(client, resumeRun);
    expect(cleared.map((halt: { number: number }) => halt.number)).toEqual([1]);
    expect(issues[0].state).toBe('closed');
    expect(issues[0].labels.map((label) => label.name)).toEqual([
      github.HALT_LABEL,
      github.RESUMED_LABEL
    ]);
    expect(requests).toContain('POST /issues/1/comments');
    expect(await github.currentHalt(client, shipJob)).toBeNull();
    expect(await github.resumeHalts(client, resumeRun)).toEqual({
      cleared: [],
      kept: []
    });
  });

  it('never lets a retried old resume clear a halt opened after its dispatch', async () => {
    // prxt0's case: attempt 2 of a resume run dispatched at 10:00 runs
    // after a new halt was opened at 11:00.
    const { client, clock } = fakeGitHub([]);
    await github.recordHalt(client, { title: 'old halt', body: 'b' });
    clock.now = Date.parse('2026-11-24T11:00:00Z');
    await github.recordHalt(client, { title: 'new halt', body: 'b' });
    const requestedBefore = await github.resumeRequestedAt(client, 9);
    expect(requestedBefore).toBe(Date.parse(RESUME_DISPATCHED));
    const { cleared, kept } = await github.resumeHalts(client, {
      ...resumeRun,
      requestedBefore
    });
    expect(cleared.map((halt: { number: number }) => halt.number)).toEqual([1]);
    expect(kept.map((halt: { number: number }) => halt.number)).toEqual([2]);
    expect(await github.currentHalt(client, shipJob)).toMatchObject({
      label: 'issue #2'
    });
    // The resume run's own plan still sees the newer halt.
    expect(
      await github.currentHalt(client, { ...shipJob, historyFallback: false })
    ).toMatchObject({ label: 'issue #2' });
  });

  it('refuses to resume without the dispatch time', async () => {
    const { client } = fakeGitHub([]);
    await expect(
      github.resumeHalts(client, { by: 'dev', runUrl: 'u' })
    ).rejects.toThrow('dispatch time');
    await expect(
      github.resumeRequestedAt({ getRun: async () => ({}) }, 9)
    ).rejects.toThrow('Cannot tell when resume run 9 was dispatched');
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

  it('finishes a stale Ship retry cleanly, with a summary and no halt', async () => {
    // GelatoGenesis's case: the skip used to leave train/result.md missing,
    // so the summary step failed the job and recorded a false halt.
    const { main } = require('./cli');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    }).trim();
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-train-skip-'));
    const saved = { ...process.env };
    Object.assign(process.env, {
      DEPLOY_TRAIN_MODE: 'prod',
      GITHUB_RUN_ATTEMPT: '2',
      GH_TOKEN: 'test-token',
      GITHUB_OUTPUT: path.join(dir, 'output')
    });
    try {
      const planFile = path.join(dir, 'plan.json');
      writeFileSync(
        planFile,
        JSON.stringify({
          mode: 'prod',
          environment: 'prod',
          halt: null,
          target_sha: head,
          run_attempt: '1',
          ship: []
        })
      );
      await main([
        'ship',
        '--plan',
        planFile,
        '--result',
        path.join(dir, 'result.json'),
        '--markdown',
        path.join(dir, 'result.md'),
        '--github-output'
      ]);
      expect(process.exitCode ?? 0).toBe(0);
      expect(
        JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'))
      ).toMatchObject({ shipped: [] });
      expect(readFileSync(path.join(dir, 'result.md'), 'utf8')).toContain(
        'Nothing was deployed and no halt was recorded.'
      );
      expect(readFileSync(path.join(dir, 'output'), 'utf8')).toContain(
        'halted=false'
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('a cancelled Ship job', () => {
    const { cancelledShipHalt, progressRecorder } = require('./cli');

    it('is a soft stop before any dispatch', () => {
      expect(cancelledShipHalt(null, null)).toBeNull();
      expect(cancelledShipHalt(null, { dispatched: [] })).toBeNull();
    });

    it('halts once it has dispatched a deploy', () => {
      expect(
        cancelledShipHalt(null, { dispatched: ['dbMigrationsLoop', 'api'] })
      ).toMatchObject({
        stop: {
          reason: 'train-cancelled',
          halt: true,
          service: 'api',
          detail: expect.stringContaining('dispatching dbMigrationsLoop, api')
        }
      });
    });

    it('follows the result when the train had finished', () => {
      const halted = { stop: { reason: 'unhealthy', halt: true } };
      expect(cancelledShipHalt(halted, { dispatched: ['api'] })).toBe(halted);
      expect(
        cancelledShipHalt({ stop: null }, { dispatched: ['api'] })
      ).toBeNull();
    });

    it('records each dispatch in the progress file', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'deploy-train-progress-'));
      try {
        const file = path.join(dir, 'progress.json');
        const record = progressRecorder(file);
        record('dbMigrationsLoop');
        record('api');
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
          dispatched: ['dbMigrationsLoop', 'api']
        });
        expect(progressRecorder(undefined)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('release-note ledger', () => {
    const groups = {
      '20': {
        services: ['nftsLoop', 'teamLoop'],
        shipped: ['teamLoop'],
        opened_at: '2026-11-24T08:00:00Z'
      }
    };

    it('starts empty, opens its issue on first save and reads it back', async () => {
      const { client, issues } = fakeGitHub([]);
      expect(await github.readLedger(client)).toEqual({
        number: null,
        groups: {}
      });
      const written = await github.writeLedger(client, {
        number: null,
        groups
      });
      expect(written.number).toBe(1);
      expect(issues[0].labels).toEqual([{ name: github.LEDGER_LABEL }]);
      expect(await github.readLedger(client)).toEqual({ number: 1, groups });
      await github.writeLedger(client, { number: 1, groups: {} });
      expect(issues).toHaveLength(1);
      expect(await github.readLedger(client)).toEqual({
        number: 1,
        groups: {}
      });
    });

    it('refuses a ledger someone has broken', async () => {
      const { client, issues } = fakeGitHub([]);
      await github.writeLedger(client, { number: null, groups });
      issues[0].body = issues[0].body!.replace(
        '"opened_at": "',
        '"opened_at": "soon '
      );
      await expect(github.readLedger(client)).rejects.toThrow(
        'Ledger issue #1'
      );
    });

    it('refuses every save when the ledger is unreadable, so new groups wait', async () => {
      const { shipLedger } = require('./cli');
      const { client, issues } = fakeGitHub([]);
      const ready = await shipLedger(client);
      expect(ready).toMatchObject({ ledger: {}, ledgerWarning: null });
      await ready.saveLedger(groups);
      await ready.saveLedger({});
      expect(issues).toHaveLength(1);
      issues[0].body = 'edited by hand';
      const broken = await shipLedger(client);
      expect(broken.ledger).toEqual({});
      await expect(broken.saveLedger({})).rejects.toThrow(
        'the ledger could not be read'
      );
      // Nothing was written over the broken issue.
      expect(issues[0].body).toBe('edited by hand');
      expect(broken.ledgerWarning).toContain('release-note ledger not read');
    });
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
