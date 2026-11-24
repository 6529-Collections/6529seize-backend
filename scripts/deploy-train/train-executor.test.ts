import { readFileSync } from 'node:fs';
import path from 'node:path';

const catalogLib = require('./catalog');
const { runTrain } = require('./executor');
const { releaseNoteGroups } = require('./plan');

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
    release_note_groups: [] as any[],
    release_note_outstanding: {} as Record<string, string[]>
  };
}

/**
 * Gives each item the release-note groups the planner would send, with
 * `behind` naming services that are behind but not in this train.
 */
function withGroups(
  items: ReturnType<typeof item>[],
  behind: { service: string; prs: number[] }[] = [],
  ledger: Record<string, unknown> = {}
) {
  const records = items
    .map((entry) => ({ service: entry.service, prs: entry.prs }))
    .concat(behind)
    .map((record) => ({ ...record, status: 'behind' }));
  const release = releaseNoteGroups(
    items.map((entry) => ({ service: entry.service, prs: entry.prs })),
    records,
    ledger
  );
  return items.map((entry) => ({
    ...entry,
    release_note_groups: release.groups.get(entry.service),
    release_note_outstanding: release.outstanding.get(entry.service)
  }));
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
  headDelaysMs?: number[];
  // The idle check passes, then the check just before dispatch sees a run.
  lateBusy?: boolean;
  // The first dispatch replaces a deploy that was waiting to run.
  displaced?: boolean;
  // How long each active-deploy lookup takes.
  activeDelaysMs?: number[];
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
      now += options.headDelaysMs?.[headCalls - 1] ?? 0;
      return head;
    },
    async listWorkflowRuns(_workflow: string, params: Record<string, string>) {
      if (!params.event) {
        activeChecks += 1;
        now += options.activeDelaysMs?.[activeChecks - 1] ?? 0;
        const busy =
          activeChecks <= (options.busyChecks ?? 0) ||
          (options.lateBusy === true && activeChecks === 2);
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
      if (options.displaced && dispatched.length === 1) {
        runs.unshift({
          id: 555,
          status: 'completed',
          conclusion: 'cancelled',
          display_title: 'Deploy api to prod',
          head_sha: TARGET,
          created_at: new Date(now).toISOString(),
          html_url: 'https://example.test/runs/555'
        });
      }
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
      trainPlan(
        withGroups([
          item('dbMigrationsLoop', [1]),
          item('api', [1, 2], ['dbMigrationsLoop']),
          item('teamLoop', [2])
        ])
      )
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
    // The halt ended teamLoop's window early, and the result says so.
    expect(result.shipped[1]).toMatchObject({
      service: 'teamLoop',
      health: 'healthy',
      note: 'watch cut short by the halt'
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
    // 30 minutes of window and 5 of ingestion margin, once a minute.
    const checks = h.checks.filter((name) => name === 'nftsLoop').length;
    expect(checks).toBeGreaterThanOrEqual(35);
    expect(checks).toBeLessThanOrEqual(38);
  });

  it('still halts on errors from the window that reach CloudWatch late', async () => {
    // prxt's case: the window has closed when the errors show up. The check
    // counts only the window's own time, so this is the window's failure.
    const h = harness();
    h.verdicts.nftsLoop = Array(34).fill('healthy').concat(['unhealthy']);
    const result = await h.run(trainPlan([item('nftsLoop', [1])]));
    expect(result.stop).toMatchObject({ reason: 'unhealthy', halt: true });
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

  it('rechecks the time budget right before dispatch, after waiting for other deploys', async () => {
    // The budget is not yet used when the train starts waiting, but is by
    // the time the other deploy finishes.
    const h = harness({ busyChecks: 20 });
    const result = await h.run(trainPlan([item('teamLoop', [1])]), {
      options: { budgetMinutes: 5 }
    });
    expect(result.stop).toMatchObject({ reason: 'time-budget', halt: false });
    expect(result.not_started).toEqual(['teamLoop']);
    expect(h.dispatched).toHaveLength(0);
  });

  it('rechecks the time budget after a slow branch read', async () => {
    // prxt's case: GitHub takes a minute to return the branch head, which
    // carries the train past its budget.
    const h = harness({ headDelaysMs: [0, 61_000] });
    const result = await h.run(trainPlan([item('teamLoop', [1])]), {
      options: { budgetMinutes: 1 }
    });
    expect(result.stop).toMatchObject({ reason: 'time-budget', halt: false });
    expect(h.dispatched).toHaveLength(0);
  });

  it('rechecks the time budget after a slow ledger save, and withdraws the group it recorded', async () => {
    const h = harness();
    const saved: any[] = [];
    const result = await h.run(
      trainPlan(
        withGroups([item('teamLoop', [5])], [{ service: 'nftsLoop', prs: [5] }])
      ),
      {
        options: { budgetMinutes: 1 },
        saveLedger: async (groups: any) => {
          h.advance(61_000);
          saved.push(structuredClone(groups));
        }
      }
    );
    expect(result.stop).toMatchObject({ reason: 'time-budget', halt: false });
    expect(h.dispatched).toHaveLength(0);
    // Recorded before the check, withdrawn after it: the group's timer
    // starts with the deploy that first sends it.
    expect(saved.map((groups) => Object.keys(groups))).toEqual([['5'], []]);
  });

  it('reports each service just before dispatching it', async () => {
    const h = harness();
    const seen: string[] = [];
    await h.run(trainPlan([item('teamLoop', [1]), item('nftsLoop', [1])]), {
      onDispatch: (service: string) => {
        seen.push(`${service}:${h.dispatched.length}`);
      }
    });
    expect(seen).toEqual(['teamLoop:0', 'nftsLoop:1']);
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

  it('defers a dependent of a held service that is not in the train', async () => {
    const h = harness();
    const api = {
      ...item('api', [1]),
      catalog_dependencies: [
        'artworkDocumentationProcessor',
        'dbMigrationsLoop'
      ]
    };
    const result = await h.run(trainPlan([api, item('teamLoop', [1])]), {
      holds: [
        {
          services: ['dbMigrationsLoop'],
          reason: 'backfill running',
          owner: null
        }
      ]
    });
    expect(result.deferred).toEqual([
      {
        service: 'api',
        reason:
          'waits for held dependency dbMigrationsLoop: held: backfill running'
      }
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

  it('keeps a group open while a member is held, recording its services before the first deploy', async () => {
    const h = harness();
    const saved: any[] = [];
    const result = await h.run(
      trainPlan(
        withGroups([item('teamLoop', [5])], [{ service: 'nftsLoop', prs: [5] }])
      ),
      {
        saveLedger: async (groups: any) => {
          saved.push({
            dispatchedBefore: h.dispatched.length,
            groups: structuredClone(groups)
          });
        }
      }
    );
    expect(JSON.parse(h.dispatched[0].inputs.release_note_groups)).toEqual([
      {
        release_group_id: 'pr-5',
        release_group_services: ['nftsLoop', 'teamLoop'],
        pull_request_number: 5,
        publish_release_note: false
      }
    ]);
    const opened_at = new Date(START).toISOString();
    expect(saved).toEqual([
      {
        dispatchedBefore: 0,
        groups: {
          '5': { services: ['nftsLoop', 'teamLoop'], shipped: [], opened_at }
        }
      },
      {
        dispatchedBefore: 1,
        groups: {
          '5': {
            services: ['nftsLoop', 'teamLoop'],
            shipped: ['teamLoop'],
            opened_at,
            runs: { teamLoop: 101 },
            unconfirmed: ['teamLoop']
          }
        }
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('publishes on the deploy that completes a ledger group and keeps the group until the receiver has forgotten it', async () => {
    const h = harness();
    const ledger = {
      '4': {
        services: ['api', 'teamLoop'],
        shipped: ['teamLoop'],
        opened_at: new Date(START - 9 * 86_400_000).toISOString()
      },
      '5': {
        services: ['nftsLoop', 'teamLoop'],
        shipped: ['teamLoop'],
        opened_at: new Date(START - 3_600_000).toISOString()
      }
    };
    const saved: any[] = [];
    await h.run(trainPlan(withGroups([item('nftsLoop', [5])], [], ledger)), {
      ledger,
      saveLedger: async (groups: any) => {
        saved.push(structuredClone(groups));
      }
    });
    expect(JSON.parse(h.dispatched[0].inputs.release_note_groups)).toEqual([
      {
        release_group_id: 'pr-5',
        release_group_services: ['nftsLoop', 'teamLoop'],
        pull_request_number: 5,
        publish_release_note: true
      }
    ]);
    // Group 4 outlived the receiver's memory. Group 5 asked to publish and
    // stays, so a member whose event is lost can be sent again with the
    // same set.
    expect(saved).toEqual([
      {
        '5': {
          services: ['nftsLoop', 'teamLoop'],
          shipped: ['teamLoop', 'nftsLoop'],
          opened_at: new Date(START - 3_600_000).toISOString(),
          runs: { nftsLoop: 101 },
          unconfirmed: ['nftsLoop'],
          publish_requested_at: expect.any(String)
        }
      }
    ]);
  });

  describe('release-note event confirmation', () => {
    const groupRun = (seen: Set<string>) => {
      const h = harness();
      const lookups: any[] = [];
      const health = {
        async check() {
          return { status: 'healthy', findings: [], note: null };
        },
        async releaseNoteSeen(query: any) {
          lookups.push(query);
          return seen.has(`${query.runId}/${query.pull}`);
        }
      };
      return { h, lookups, health };
    };

    it('confirms each member whose event the release-notes loop logged', async () => {
      const { h, lookups, health } = groupRun(new Set(['101/5']));
      const saved: any[] = [];
      const result = await h.run(
        trainPlan(
          withGroups(
            [item('teamLoop', [5])],
            [{ service: 'nftsLoop', prs: [5] }]
          )
        ),
        {
          health,
          saveLedger: async (groups: any) => {
            saved.push(structuredClone(groups));
          }
        }
      );
      expect(lookups).toEqual([
        {
          region: 'us-east-1',
          functionName: 'releaseNotesGenerationLoop',
          pull: '5',
          service: 'teamLoop',
          runId: 101,
          since: START
        }
      ]);
      expect(saved.at(-1)['5'].unconfirmed).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('reports a member whose event never arrived, and keeps the group', async () => {
      // prxt's third case: the deploy succeeded but its release-note event
      // never reached the receiver.
      const { h, health } = groupRun(new Set());
      const saved: any[] = [];
      const result = await h.run(
        trainPlan(withGroups([item('teamLoop', [5]), item('nftsLoop', [5])])),
        {
          health,
          saveLedger: async (groups: any) => {
            saved.push(structuredClone(groups));
          }
        }
      );
      expect(saved.at(-1)['5']).toMatchObject({
        publish_requested_at: expect.any(String),
        unconfirmed: ['teamLoop', 'nftsLoop']
      });
      expect(result.warnings).toEqual([
        'release-note event for teamLoop (deploy run 101, group pr-5) has not reached the release-notes loop; send it again by deploying teamLoop by hand with group pr-5 from the ledger issue',
        'release-note event for nftsLoop (deploy run 102, group pr-5) has not reached the release-notes loop; send it again by deploying nftsLoop by hand with group pr-5 from the ledger issue'
      ]);
    });

    it('confirms a deploy that carried two groups group by group', async () => {
      // prxt's case: one deploy carried pr-5 and pr-6, and only pr-5's
      // event was recorded. pr-6's must still be reported.
      const { h, lookups, health } = groupRun(new Set(['101/5']));
      const result = await h.run(
        trainPlan(
          withGroups(
            [item('teamLoop', [5, 6])],
            [
              { service: 'nftsLoop', prs: [5] },
              { service: 'api', prs: [6] }
            ]
          )
        ),
        { health, saveLedger: async () => undefined }
      );
      expect(lookups.map((query) => [query.pull, query.runId])).toEqual([
        ['5', 101],
        ['6', 101]
      ]);
      expect(result.warnings).toEqual([
        'release-note event for teamLoop (deploy run 101, group pr-6) has not reached the release-notes loop; send it again by deploying teamLoop by hand with group pr-6 from the ledger issue'
      ]);
    });

    it('never stops the train when the logs cannot be read', async () => {
      const { h } = groupRun(new Set());
      const result = await h.run(
        trainPlan(withGroups([item('teamLoop', [5]), item('nftsLoop', [5])])),
        {
          health: {
            async check() {
              return { status: 'healthy', findings: [], note: null };
            },
            async releaseNoteSeen() {
              throw new Error('AccessDenied');
            }
          },
          saveLedger: async () => undefined
        }
      );
      expect(result.stop).toBeNull();
      expect(result.warnings).toEqual([
        'release-note events not confirmed: AccessDenied'
      ]);
    });
  });

  it('defers a group that reached its grace day during the last lookup before dispatch', async () => {
    // prxt's case: when the Ship job starts, the recorded set can still
    // reach the receiver in time; the last GitHub lookup before dispatch
    // takes two minutes and crosses into the grace day (seven days less the
    // two hours an event can take to arrive).
    const h = harness({ activeDelaysMs: [0, 120_000] });
    const opened = START - (7 * 86_400_000 - 2 * 3_600_000) + 60_000;
    const ledger = {
      '5': {
        services: ['nftsLoop', 'teamLoop'],
        shipped: ['teamLoop'],
        opened_at: new Date(opened).toISOString()
      }
    };
    const plan = trainPlan(withGroups([item('nftsLoop', [5])], [], ledger));
    const result = await h.run(plan, {
      ledger,
      saveLedger: async () => undefined
    });
    expect(h.dispatched).toEqual([]);
    expect(result.deferred).toEqual([
      {
        service: 'nftsLoop',
        reason: `release-note group pr-5 may still be held by the receiver until ${new Date(opened + 8 * 86_400_000).toISOString()}; the train ships it after that`
      }
    ]);
  });

  it('stops before dispatch when another deploy started after the idle check', async () => {
    // The idle check passes, then a deploy appears before dispatch.
    const h = harness({ busyChecks: 0, lateBusy: true });
    const result = await h.run(trainPlan([item('teamLoop', [1])]));
    expect(result.stop).toMatchObject({ reason: 'busy', halt: false });
    expect(h.dispatched).toEqual([]);
  });

  it('halts after its deploy when the dispatch replaced a waiting deploy', async () => {
    const h = harness({ displaced: true });
    const result = await h.run(
      trainPlan([item('teamLoop', [1]), item('nftsLoop', [1])])
    );
    expect(result.shipped.map((entry: any) => entry.service)).toEqual([
      'teamLoop'
    ]);
    expect(result.stop).toMatchObject({
      reason: 'displaced-deploy',
      halt: true,
      service: 'teamLoop'
    });
    expect(result.stop.detail).toContain('https://example.test/runs/555');
    expect(result.not_started).toEqual(['nftsLoop']);
  });

  it('does not publish when the group member planned to publish is deferred mid-train', async () => {
    const h = harness();
    const saved: any[] = [];
    const result = await h.run(
      trainPlan(withGroups([item('teamLoop', [6]), item('nftsLoop', [6])])),
      {
        holds: [{ services: ['nftsLoop'], reason: 'paused', owner: null }],
        saveLedger: async (groups: any) => {
          saved.push(structuredClone(groups));
        }
      }
    );
    expect(result.deferred.map((entry: any) => entry.service)).toEqual([
      'nftsLoop'
    ]);
    expect(
      JSON.parse(h.dispatched[0].inputs.release_note_groups)[0]
        .publish_release_note
    ).toBe(false);
    expect(saved.at(-1)['6'].shipped).toEqual(['teamLoop']);
  });

  it('defers a deploy whose new group cannot be recorded first, and still ships one that completes its group', async () => {
    const h = harness();
    const result = await h.run(
      trainPlan([
        ...withGroups(
          [item('teamLoop', [5])],
          [{ service: 'nftsLoop', prs: [5] }]
        ),
        ...withGroups([item('api', [7])])
      ]),
      {
        saveLedger: async () => {
          throw new Error('API rate limit');
        }
      }
    );
    expect(result.deferred).toEqual([
      {
        service: 'teamLoop',
        reason:
          'release-note group pr-5 could not be recorded before its first deploy: API rate limit'
      }
    ]);
    expect(result.stop).toBeNull();
    // api's group is complete with this deploy: nothing to record first.
    expect(h.dispatched.map((entry) => entry.inputs.service)).toEqual(['api']);
  });

  it('keeps the recorded group when only the save after the deploy fails', async () => {
    // prxt's case: the first deploy succeeds and the ledger write after it
    // fails. The service set was saved before the deploy, so the next
    // train sends the same set and the receiver accepts it.
    const h = harness();
    let persisted: Record<string, any> = {};
    let saves = 0;
    const result = await h.run(
      trainPlan(
        withGroups([item('teamLoop', [5])], [{ service: 'nftsLoop', prs: [5] }])
      ),
      {
        saveLedger: async (groups: any) => {
          saves += 1;
          if (saves > 1) throw new Error('API rate limit');
          persisted = structuredClone(groups);
        }
      }
    );
    expect(result.shipped).toHaveLength(1);
    expect(result.warnings).toEqual([
      'release-note ledger not saved after teamLoop: API rate limit'
    ]);
    const [next] = withGroups([item('nftsLoop', [5])], [], persisted);
    expect(next.release_note_groups).toEqual([
      {
        release_group_id: 'pr-5',
        release_group_services: ['nftsLoop', 'teamLoop'],
        pull_request_number: 5,
        publish_release_note: true
      }
    ]);
  });

  it('records a group again when its ledger entry has expired', async () => {
    const h = harness();
    const stale = {
      '5': {
        services: ['teamLoop'],
        shipped: [],
        opened_at: new Date(START - 9 * 86_400_000).toISOString()
      }
    };
    const saved: any[] = [];
    await h.run(
      // The plan ignores the expired entry and fixes a fresh set.
      trainPlan(
        withGroups([item('teamLoop', [5])], [{ service: 'nftsLoop', prs: [5] }])
      ),
      {
        ledger: structuredClone(stale),
        saveLedger: async (groups: any) => {
          saved.push({
            dispatchedBefore: h.dispatched.length,
            groups: structuredClone(groups)
          });
        }
      }
    );
    expect(saved[0]).toEqual({
      dispatchedBefore: 0,
      groups: {
        '5': {
          services: ['nftsLoop', 'teamLoop'],
          shipped: [],
          opened_at: new Date(START).toISOString()
        }
      }
    });
  });

  it('records a group only once across its members', async () => {
    const h = harness();
    const saved: any[] = [];
    await h.run(
      trainPlan(
        withGroups(
          [item('teamLoop', [5]), item('nftsLoop', [5])],
          [{ service: 'api', prs: [5] }]
        )
      ),
      {
        saveLedger: async (groups: any) => {
          saved.push({
            dispatchedBefore: h.dispatched.length,
            shipped: structuredClone(groups['5'].shipped)
          });
        }
      }
    );
    // One save before the first deploy, then one after each deploy.
    expect(saved).toEqual([
      { dispatchedBefore: 0, shipped: [] },
      { dispatchedBefore: 1, shipped: ['teamLoop'] },
      { dispatchedBefore: 2, shipped: ['teamLoop', 'nftsLoop'] }
    ]);
  });
});
