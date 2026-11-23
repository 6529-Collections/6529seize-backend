import { readFileSync } from 'node:fs';
import path from 'node:path';

const catalogLib = require('./catalog');
const planLib = require('./plan');

const catalog = catalogLib.loadCatalog(
  JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../src/config/deploy-services.json'),
      'utf8'
    )
  )
);
const TARGET = 'b'.repeat(40);
const DEPLOYED = 'a'.repeat(40);
const QUIET_TIME = Date.parse('2026-11-24T10:00:00Z');

type RecordOverrides = {
  status?: string;
  prs?: number[];
  behind_since?: string | null;
  mode?: string;
  reasons?: string[];
};

function record(service: string, overrides: RecordOverrides = {}) {
  return {
    service,
    status: overrides.status ?? 'behind',
    deployed: {
      sha: DEPLOYED,
      completed_at: '2026-11-20T00:00:00Z'
    },
    reasons: overrides.reasons ?? [
      'bundle changed (1 bundled source file differ)'
    ],
    prs: overrides.prs ?? [100],
    behind_since:
      overrides.behind_since === undefined
        ? '2026-11-23T00:00:00Z'
        : overrides.behind_since,
    expects_db_auth: true,
    train: {
      mode: overrides.mode ?? 'auto',
      reason: overrides.mode === 'manual' ? 'held for review' : null
    }
  };
}

function plan(
  records: ReturnType<typeof record>[],
  extra: Record<string, unknown> = {}
) {
  return planLib.buildTrainPlan({
    catalog,
    drift: { environment: 'prod', target_sha: TARGET, services: records },
    mode: 'prod',
    now: QUIET_TIME,
    ...extra
  });
}

describe('deploy train mode switch', () => {
  it.each([
    [undefined, 'off'],
    ['', 'off'],
    ['off', 'off'],
    ['report', 'report'],
    ['prod', 'prod'],
    [' prod ', 'prod'],
    ['production', 'off'],
    ['PROD', 'off']
  ])('maps DEPLOY_TRAIN_MODE %j to %s', (variable, expected) => {
    expect(
      planLib.resolveMode({ variable, requested: '', eventName: 'push' }).mode
    ).toBe(expected);
  });

  it('lets a dispatch ask for a dry run but never escalate', () => {
    expect(
      planLib.resolveMode({
        variable: 'prod',
        requested: 'report',
        eventName: 'workflow_dispatch'
      }).mode
    ).toBe('report');
    expect(
      planLib.resolveMode({
        variable: 'off',
        requested: 'report',
        eventName: 'workflow_dispatch'
      }).mode
    ).toBe('report');
    expect(
      planLib.resolveMode({
        variable: 'report',
        requested: 'prod',
        eventName: 'workflow_dispatch'
      }).mode
    ).toBe('report');
    expect(
      planLib.resolveMode({
        variable: 'off',
        requested: 'report',
        eventName: 'push'
      }).mode
    ).toBe('off');
  });

  it('explains an unrecognised mode', () => {
    expect(
      planLib.resolveMode({ variable: 'yes', requested: '', eventName: 'push' })
        .notes[0]
    ).toContain('treated as off');
  });
});

describe('deploy train plan', () => {
  it('ships behind services in dependency order with dbMigrationsLoop first', () => {
    const result = plan([
      record('subscriptionsDaily', { behind_since: '2026-11-01T00:00:00Z' }),
      record('api'),
      record('pushNotificationsHandler'),
      record('dbMigrationsLoop', { behind_since: '2026-11-22T00:00:00Z' }),
      record('nftsLoop', { behind_since: '2026-11-02T00:00:00Z' }),
      record('teamLoop', { status: 'current', prs: [] })
    ]);
    const order = result.ship.map((item: { service: string }) => item.service);
    expect(order[0]).toBe('dbMigrationsLoop');
    expect(order.indexOf('api')).toBeLessThan(
      order.indexOf('subscriptionsDaily')
    );
    expect(order.indexOf('pushNotificationsHandler')).toBeLessThan(
      order.indexOf('subscriptionsDaily')
    );
    // Oldest drift first among services that are ready together.
    expect(order.indexOf('nftsLoop')).toBeLessThan(order.indexOf('api'));
    expect(order).not.toContain('teamLoop');
    expect(result.current_count).toBe(1);
    expect(result.ship[1].region).toBe('us-east-1');
    expect(
      result.ship.find(
        (item: { service: string }) => item.service === 'subscriptionsDaily'
      ).dependencies
    ).toEqual(
      expect.arrayContaining([
        'api',
        'dbMigrationsLoop',
        'pushNotificationsHandler'
      ])
    );
  });

  it('builds one release-note group per PR and publishes it on the last service', () => {
    const result = plan([
      record('nftsLoop', {
        prs: [10, 11],
        behind_since: '2026-11-01T00:00:00Z'
      }),
      record('teamLoop', {
        prs: [11, 12],
        behind_since: '2026-11-02T00:00:00Z'
      }),
      record('ethPriceLoop', {
        prs: [11],
        behind_since: '2026-11-03T00:00:00Z'
      })
    ]);
    const byService = new Map<string, any>(
      result.ship.map((item: { service: string }) => [item.service, item])
    );
    expect(
      result.ship.map((item: { service: string }) => item.service)
    ).toEqual(['nftsLoop', 'teamLoop', 'ethPriceLoop']);
    expect(byService.get('nftsLoop').release_note_groups).toEqual([
      {
        release_group_id: 'pr-10',
        release_group_services: ['nftsLoop'],
        pull_request_number: 10,
        publish_release_note: true
      },
      {
        release_group_id: 'pr-11',
        release_group_services: ['ethPriceLoop', 'nftsLoop', 'teamLoop'],
        pull_request_number: 11,
        publish_release_note: false
      }
    ]);
    expect(
      byService.get('ethPriceLoop').release_note_groups[0].publish_release_note
    ).toBe(true);
    expect(
      byService
        .get('teamLoop')
        .release_note_groups.map((group: any) => [
          group.pull_request_number,
          group.publish_release_note
        ])
    ).toEqual([
      [11, false],
      [12, true]
    ]);
  });

  it('defers manual, unattributed, oversized and blacked-out services', () => {
    const result = plan(
      [
        record('nftsLoop', { mode: 'manual' }),
        record('teamLoop', { prs: [] }),
        record('ethPriceLoop', {
          prs: Array.from({ length: 101 }, (_, index) => index + 1)
        }),
        record('royaltiesLoop'),
        record('transactionsLoop')
      ],
      { now: Date.parse('2026-11-24T02:00:00Z') }
    );
    const kinds = new Map(
      result.deferred.map((entry: { service: string; kind: string }) => [
        entry.service,
        entry.kind
      ])
    );
    expect(kinds.get('nftsLoop')).toBe('manual');
    expect(kinds.get('teamLoop')).toBe('release-notes');
    expect(kinds.get('ethPriceLoop')).toBe('release-notes');
    expect(kinds.get('royaltiesLoop')).toBe('blackout');
    expect(
      result.ship.map((item: { service: string }) => item.service)
    ).toEqual(['transactionsLoop']);
  });

  it('holds dependents of a deferred or unassessed dependency', () => {
    const result = plan([
      record('dbMigrationsLoop', { mode: 'manual' }),
      record('api'),
      record('subscriptionsDaily'),
      record('teamLoop'),
      record('xTdhLoop', { status: 'error', reasons: ['esbuild failed'] }),
      record('tdhLoop')
    ]);
    expect(
      result.ship.map((item: { service: string }) => item.service)
    ).toEqual(['teamLoop']);
    const reasons = new Map(
      result.deferred.map((entry: { service: string; reason: string }) => [
        entry.service,
        entry.reason
      ])
    );
    expect(reasons.get('api')).toBe('waits for dependency dbMigrationsLoop');
    expect(reasons.get('subscriptionsDaily')).toMatch(/^waits for dependency /);
    expect(reasons.get('xTdhLoop')).toBe('not assessed: esbuild failed');
    expect(reasons.get('tdhLoop')).toMatch(
      /waits for dependency (dbMigrationsLoop|xTdhLoop)/
    );
  });

  it('defers a service whose release-note input would exceed the dispatch limit', () => {
    const many = Array.from({ length: 62 }, (_, index) => 1000 + index);
    const names = catalog.services
      .map((entry: { name: string }) => entry.name)
      .filter((name: string) => name !== 'dbMigrationsLoop' && name !== 'api');
    const records = names.slice(0, 50).map((name: string) =>
      record(name, {
        prs: many,
        behind_since: '2026-11-01T00:00:00Z'
      })
    );
    const result = planLib.buildTrainPlan({
      catalog,
      drift: { environment: 'staging', target_sha: TARGET, services: records },
      mode: 'prod',
      now: QUIET_TIME
    });
    for (const item of result.ship) {
      expect(
        JSON.stringify(item.release_note_groups).length
      ).toBeLessThanOrEqual(planLib.MAX_GROUP_INPUT_CHARS);
    }
    expect(
      result.deferred.some((entry: { reason: string }) =>
        entry.reason.includes('workflow input size')
      )
    ).toBe(true);
  });

  it('holds services named by a temporary hold, with their dependents', () => {
    const result = plan(
      [record('dbMigrationsLoop'), record('api'), record('teamLoop')],
      {
        holds: [
          {
            services: ['dbMigrationsLoop'],
            reason: 'scoped migration first',
            owner: null
          }
        ]
      }
    );
    const kinds = new Map(
      result.deferred.map((entry: { service: string; kind: string }) => [
        entry.service,
        entry.kind
      ])
    );
    expect(kinds.get('dbMigrationsLoop')).toBe('hold');
    expect(kinds.get('api')).toBe('dependency');
    expect(
      result.ship.map((item: { service: string }) => item.service)
    ).toEqual(['teamLoop']);
  });

  it('defers a service whose change includes commits without a pull request', () => {
    const partly = {
      ...record('teamLoop', { prs: [123] }),
      unattributed_commits: ['d'.repeat(40)]
    };
    const result = plan([partly, record('nftsLoop')]);
    expect(result.deferred).toEqual([
      expect.objectContaining({
        service: 'teamLoop',
        kind: 'release-notes',
        reason: expect.stringContaining('dddddddddd')
      })
    ]);
    expect(
      result.ship.map((item: { service: string }) => item.service)
    ).toEqual(['nftsLoop']);
  });

  it('says no service is eligible when everything behind is deferred', () => {
    const report = require('./report');
    const blocked = plan([record('royaltiesLoop')], {
      now: Date.parse('2026-11-24T02:00:00Z')
    });
    expect(report.renderPlanMarkdown(blocked)).toContain(
      'No service is eligible to ship'
    );
    expect(report.renderPlanMarkdown(plan([]))).toContain(
      'Nothing to ship: every automatic service matches the target.'
    );
  });

  it('reports deployments ahead of the target without claiming a match', () => {
    const report = require('./report');
    const drift = {
      environment: 'prod',
      target_sha: TARGET,
      target_committed_at: '2026-11-24T00:00:00Z',
      generated_at: '2026-11-24T10:00:00Z',
      stats: {
        services: 2,
        seconds: 1,
        builds: 0,
        cache_hits: 0,
        reused_target_bundle: 0
      },
      services: [
        record('teamLoop', { status: 'ahead' }),
        record('nftsLoop', { status: 'current' })
      ]
    };
    const alert = report.driftAlert(drift);
    expect(alert.status).toBe('success');
    expect(alert.title).toBe(
      'Backend drift check: no prod service behind main bbbbbbbbbb'
    );
    expect(alert.description).toContain(
      'Deployed ahead of main bbbbbbbbbb: teamLoop.'
    );
    expect(report.renderDriftMarkdown(drift)).toContain(
      'No service is behind the target or unassessed.'
    );
  });

  it('lists never-deployed and ahead services without shipping them', () => {
    const result = plan([
      record('signedRecordLogLoop', { status: 'never-deployed' }),
      record('teamLoop', { status: 'ahead' })
    ]);
    expect(result.ship).toEqual([]);
    expect(result.never_deployed).toEqual(['signedRecordLogLoop']);
    expect(result.ahead).toEqual(['teamLoop']);
  });
});
