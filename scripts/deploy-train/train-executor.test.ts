import { readFileSync } from 'node:fs';
import path from 'node:path';

const catalogLib = require('./catalog');
const { runTrain } = require('./executor');

const catalog = catalogLib.loadCatalog(
  JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../src/config/deploy-services.json'),
      'utf8'
    )
  )
);
const TARGET = 'c'.repeat(40);
const START = Date.parse('2026-11-24T10:00:00Z');

function item(service: string, prs: number[], dependencies: string[] = []) {
  return {
    service,
    prs,
    dependencies,
    region: 'us-east-1',
    verification_targets: [service],
    validation_profile: 'lambda-version',
    expects_db_auth: true,
    release_note_groups: []
  };
}

function trainPlan(items: ReturnType<typeof item>[]) {
  return {
    mode: 'prod',
    environment: 'prod',
    target_sha: TARGET,
    lookahead_minutes: 15,
    ship: items,
    deferred: []
  };
}

type FakeOptions = {
  conclusions?: Record<string, string>;
  heads?: string[];
  busyChecks?: number;
  reportRunId?: boolean;
  failedStep?: string;
  steps?: { name: string; conclusion: string | null }[];
};

function harness(options: FakeOptions = {}) {
  let now = START;
  let headCalls = 0;
  let activeChecks = 0;
  const runs: any[] = [];
  const dispatched: any[] = [];
  const client = {
    async getBranchSha() {
      const heads = options.heads ?? [];
      const head = heads[Math.min(headCalls, heads.length - 1)] ?? TARGET;
      headCalls += 1;
      return head;
    },
    async listWorkflowRuns(_workflow: string, params: Record<string, string>) {
      if (!params.event) {
        activeChecks += 1;
        const busy = activeChecks <= (options.busyChecks ?? 0);
        return {
          workflow_runs: busy
            ? [
                {
                  id: 999,
                  status: 'in_progress',
                  display_title: 'Deploy api to prod',
                  html_url: 'https://example.test/runs/999'
                }
              ]
            : runs
        };
      }
      return { workflow_runs: runs };
    },
    async dispatchWorkflow(workflow: string, ref: string, inputs: any) {
      dispatched.push({ workflow, ref, inputs });
      const id = 100 + dispatched.length;
      runs.unshift({
        id,
        status: 'completed',
        conclusion: options.conclusions?.[inputs.service] ?? 'success',
        display_title: `Deploy ${inputs.service} to prod`,
        head_sha: TARGET,
        created_at: new Date(now).toISOString(),
        run_started_at: new Date(now).toISOString(),
        html_url: `https://example.test/runs/${id}`
      });
      return options.reportRunId === false ? null : id;
    },
    async getRun(id: number) {
      return runs.find((run) => run.id === id);
    },
    async listRunJobs() {
      return [
        {
          name: 'Build and deploy',
          steps: options.steps ?? [
            {
              name: options.failedStep ?? 'Deploy service',
              conclusion: 'failure'
            }
          ]
        }
      ];
    }
  };
  const verdicts: Record<string, string[]> = {};
  const checks: string[] = [];
  const health = {
    async check(entry: { service: string }) {
      checks.push(entry.service);
      const queue = verdicts[entry.service];
      const status = queue && queue.length > 0 ? queue.shift()! : 'healthy';
      if (status === 'throw') throw new Error('AccessDenied for logs');
      return {
        status,
        findings: status === 'unhealthy' ? ['logged "Access denied"'] : [],
        note: status === 'pending' ? 'not invoked since deploy' : null
      };
    }
  };
  const run = (
    plan: ReturnType<typeof trainPlan>,
    extra: Record<string, unknown> = {}
  ) =>
    runTrain({
      plan,
      catalog,
      client,
      health,
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      ...extra
    });
  return {
    run,
    dispatched,
    verdicts,
    checks,
    advance: (ms: number) => (now += ms)
  };
}

describe('deploy train executor', () => {
  it('deploys in order, pinned to the plan commit, with per-PR release-note groups', async () => {
    const h = harness();
    const result = await h.run(
      trainPlan([
        item('dbMigrationsLoop', [1]),
        item('api', [1, 2], ['dbMigrationsLoop']),
        item('teamLoop', [2])
      ])
    );
    expect(result.stop).toBeNull();
    expect(
      result.shipped.map((entry: any) => [entry.service, entry.health])
    ).toEqual([
      ['dbMigrationsLoop', 'healthy'],
      ['api', 'healthy'],
      ['teamLoop', 'healthy']
    ]);
    expect(h.dispatched.map((entry) => entry.ref)).toEqual([
      'main',
      'main',
      'main'
    ]);
    const apiInputs = h.dispatched[1].inputs;
    expect(apiInputs).toMatchObject({
      environment: 'prod',
      service: 'api',
      expected_source_sha: TARGET
    });
    expect(JSON.parse(apiInputs.release_note_groups)).toEqual([
      {
        release_group_id: 'pr-1',
        release_group_services: ['api', 'dbMigrationsLoop'],
        pull_request_number: 1,
        publish_release_note: true
      },
      {
        release_group_id: 'pr-2',
        release_group_services: ['api', 'teamLoop'],
        pull_request_number: 2,
        publish_release_note: false
      }
    ]);
    expect(
      JSON.parse(h.dispatched[2].inputs.release_note_groups)[0]
        .publish_release_note
    ).toBe(true);
  });

  it('finds the dispatched run when GitHub does not return its ID', async () => {
    const h = harness({ reportRunId: false });
    const result = await h.run(trainPlan([item('teamLoop', [3])]));
    expect(result.shipped[0].run_id).toBe(101);
  });

  it('stops softly when main moves before a deploy', async () => {
    const h = harness({ heads: [TARGET, TARGET, 'd'.repeat(40)] });
    const result = await h.run(
      trainPlan([
        item('teamLoop', [1]),
        item('nftsLoop', [1]),
        item('ethPriceLoop', [1])
      ])
    );
    expect(result.stop).toMatchObject({ reason: 'main-moved', halt: false });
    expect(result.shipped.map((entry: any) => entry.service)).toEqual([
      'teamLoop'
    ]);
    expect(result.not_started).toEqual(['nftsLoop', 'ethPriceLoop']);
  });

  it('halts on a failed deploy and names the failed step', async () => {
    const h = harness({ conclusions: { nftsLoop: 'failure' } });
    const result = await h.run(
      trainPlan([item('nftsLoop', [1]), item('teamLoop', [1])])
    );
    expect(result.stop).toMatchObject({
      reason: 'deploy-failed',
      halt: true,
      service: 'nftsLoop',
      detail: 'nftsLoop deploy failure at Deploy service'
    });
    expect(result.not_started).toEqual(['teamLoop']);
    expect(h.dispatched).toHaveLength(1);
  });

  it('treats a refused stale commit as main moving, not a failure', async () => {
    const h = harness({
      conclusions: { nftsLoop: 'failure' },
      heads: [TARGET, TARGET, 'e'.repeat(40)],
      steps: [
        {
          name: 'Validate dispatch inputs before using credentials',
          conclusion: 'failure'
        },
        { name: 'Deploy service', conclusion: 'skipped' }
      ]
    });
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toMatchObject({ reason: 'main-moved', halt: false });
  });

  it('halts when a deploy fails after changing production, even if main moved', async () => {
    const h = harness({
      conclusions: { nftsLoop: 'failure' },
      heads: [TARGET, TARGET, 'e'.repeat(40)],
      steps: [
        {
          name: 'Validate dispatch inputs before using credentials',
          conclusion: 'success'
        },
        { name: 'Deploy service', conclusion: 'success' },
        { name: 'Verify immutable Lambda code', conclusion: 'failure' }
      ]
    });
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toMatchObject({
      reason: 'deploy-failed',
      halt: true,
      detail: 'nftsLoop deploy failure at Verify immutable Lambda code'
    });
  });

  it('halts when a cancelled deploy had started changing production', async () => {
    const h = harness({
      conclusions: { nftsLoop: 'cancelled' },
      steps: [
        { name: 'Deploy service', conclusion: 'cancelled' },
        { name: 'Verify immutable Lambda code', conclusion: 'skipped' }
      ]
    });
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toMatchObject({
      reason: 'deploy-cancelled-after-change',
      halt: true
    });
  });

  it('stops softly when someone cancels the deploy before it changed anything', async () => {
    const h = harness({
      conclusions: { nftsLoop: 'cancelled' },
      steps: [
        {
          name: 'Install root dependencies for manual build',
          conclusion: 'cancelled'
        },
        { name: 'Deploy service', conclusion: 'skipped' }
      ]
    });
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toMatchObject({
      reason: 'deploy-cancelled',
      halt: false
    });
  });

  it('halts when a deployed service turns unhealthy', async () => {
    const h = harness();
    h.verdicts.nftsLoop = ['pending', 'unhealthy'];
    const result = await h.run(
      trainPlan([item('nftsLoop', [1]), item('teamLoop', [1])])
    );
    expect(result.stop).toMatchObject({
      reason: 'unhealthy',
      halt: true,
      service: 'nftsLoop'
    });
    expect(h.dispatched).toHaveLength(1);
  });

  it('keeps watching services that have not run and halts if one fails later', async () => {
    const h = harness();
    // Eleven checks while waiting after its deploy, one sweep right after.
    h.verdicts.nftsLoop = Array(12).fill('pending').concat(['unhealthy']);
    const result = await h.run(
      trainPlan([
        item('nftsLoop', [1]),
        item('teamLoop', [1]),
        item('ethPriceLoop', [1])
      ])
    );
    expect(result.stop).toMatchObject({
      reason: 'unhealthy',
      service: 'nftsLoop'
    });
    expect(result.shipped.map((entry: any) => entry.service)).toEqual([
      'nftsLoop',
      'teamLoop'
    ]);
  });

  it('keeps watching a healthy service and halts when its errors cross the threshold later', async () => {
    // prxt0's case: one clean invocation, then the error threshold is
    // crossed while the train is deploying the next service.
    const h = harness();
    h.verdicts.nftsLoop = ['healthy', 'healthy', 'unhealthy'];
    const result = await h.run(
      trainPlan([
        item('nftsLoop', [1]),
        item('teamLoop', [1]),
        item('ethPriceLoop', [1])
      ])
    );
    expect(result.stop).toMatchObject({
      reason: 'unhealthy',
      halt: true,
      service: 'nftsLoop'
    });
    expect(h.dispatched.map((entry) => entry.inputs.service)).toEqual([
      'nftsLoop',
      'teamLoop'
    ]);
    expect(result.not_started).toEqual(['ethPriceLoop']);
    expect(result.shipped[0]).toMatchObject({
      service: 'nftsLoop',
      health: 'unhealthy'
    });
  });

  it('keeps watching after the last deploy until the window closes', async () => {
    const h = harness();
    h.verdicts.nftsLoop = Array(10).fill('healthy').concat(['unhealthy']);
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toMatchObject({ reason: 'unhealthy', halt: true });
  });

  it('stops checking a service once its window has closed', async () => {
    const h = harness();
    h.verdicts.nftsLoop = Array(40).fill('healthy').concat(['unhealthy']);
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toBeNull();
    expect(result.shipped[0].health).toBe('healthy');
    const checks = h.checks.filter((name) => name === 'nftsLoop').length;
    expect(checks).toBeGreaterThanOrEqual(30);
    expect(checks).toBeLessThanOrEqual(33);
  });

  it('reports services that never ran during the train as unverified', async () => {
    const h = harness();
    h.verdicts.nftsLoop = Array(200).fill('pending');
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toBeNull();
    expect(result.shipped[0].health).toBe('unverified');
    expect(result.watch).toEqual([
      {
        service: 'nftsLoop',
        status: 'unverified',
        note: 'not invoked since deploy'
      }
    ]);
  });

  it('fails closed when the health check cannot run', async () => {
    const h = harness();
    h.verdicts.nftsLoop = ['throw'];
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop.reason).toBe('unhealthy');
    expect(result.stop.detail).toContain(
      'health check could not run: AccessDenied'
    );
  });

  it('defers a service that entered a quiet window, and its dependents', async () => {
    const h = harness();
    h.advance(Date.parse('2026-11-24T01:50:00Z') - START);
    const result = await h.run(
      trainPlan([
        item('royaltiesLoop', [1]),
        item('api', [1], ['royaltiesLoop']),
        item('teamLoop', [1])
      ])
    );
    expect(result.deferred).toEqual([
      expect.objectContaining({ service: 'royaltiesLoop' }),
      { service: 'api', reason: 'waits for dependency royaltiesLoop' }
    ]);
    expect(result.shipped.map((entry: any) => entry.service)).toEqual([
      'teamLoop'
    ]);
  });

  it('waits for another deploy to finish, and gives up after the busy limit', async () => {
    const waiting = harness({ busyChecks: 2 });
    const shipped = await waiting.run(trainPlan([item('teamLoop', [1])]));
    expect(shipped.shipped).toHaveLength(1);
    const blocked = harness({ busyChecks: 1000 });
    const result = await blocked.run(trainPlan([item('teamLoop', [1])]));
    expect(result.stop).toMatchObject({ reason: 'busy', halt: false });
    expect(blocked.dispatched).toHaveLength(0);
  });

  it('stops before a new deploy once the time budget is used', async () => {
    const h = harness();
    h.verdicts.teamLoop = Array(20).fill('pending');
    const result = await h.run(
      trainPlan([item('teamLoop', [1]), item('nftsLoop', [1])]),
      { options: { budgetMinutes: 1 } }
    );
    expect(result.stop).toMatchObject({ reason: 'time-budget', halt: false });
    expect(result.not_started).toEqual(['nftsLoop']);
  });

  it('rechecks quiet windows right before dispatch, after waiting for other deploys', async () => {
    // Monday 17:10 Athens: clear of the 17:30 mint launch window, but other
    // deploys keep the train waiting until 17:31.
    const h = harness({ busyChecks: 21 });
    h.advance(Date.parse('2026-11-23T15:10:00Z') - START);
    const result = await h.run(trainPlan([item('claimsBuilder', [1])]));
    expect(h.dispatched).toHaveLength(0);
    expect(result.deferred).toEqual([
      {
        service: 'claimsBuilder',
        reason: expect.stringMatching(
          /^quiet window from 2026-11-23T15:31Z: Memes mint launch/
        )
      }
    ]);
  });

  it('defers a held service and the services that depend on it', async () => {
    const h = harness();
    const result = await h.run(
      trainPlan([
        item('dbMigrationsLoop', [1]),
        item('api', [1], ['dbMigrationsLoop']),
        item('teamLoop', [1])
      ]),
      {
        holds: [
          {
            services: ['dbMigrationsLoop'],
            reason: 'operator runs a scoped migration first',
            owner: 'dev'
          }
        ]
      }
    );
    expect(result.deferred).toEqual([
      {
        service: 'dbMigrationsLoop',
        reason: 'held: operator runs a scoped migration first (set by dev)'
      },
      { service: 'api', reason: 'waits for dependency dbMigrationsLoop' }
    ]);
    expect(h.dispatched.map((entry) => entry.inputs.service)).toEqual([
      'teamLoop'
    ]);
  });

  it('never deploys a migration dependent after the migration deploy fails', async () => {
    const h = harness({ conclusions: { dbMigrationsLoop: 'failure' } });
    const result = await h.run(
      trainPlan([
        item('dbMigrationsLoop', [1]),
        item('api', [1], ['dbMigrationsLoop'])
      ])
    );
    expect(result.stop).toMatchObject({ reason: 'deploy-failed', halt: true });
    expect(result.not_started).toEqual(['api']);
    expect(h.dispatched).toHaveLength(1);
  });

  it('continues past a service the new build has not served yet, and flags it', async () => {
    const h = harness();
    h.verdicts.nftsLoop = Array(200).fill('pending');
    const result = await h.run(
      trainPlan([item('nftsLoop', [1]), item('teamLoop', [1])])
    );
    expect(result.stop).toBeNull();
    expect(
      result.shipped.map((entry: any) => [entry.service, entry.health])
    ).toEqual([
      ['nftsLoop', 'unverified'],
      ['teamLoop', 'healthy']
    ]);
  });
});
