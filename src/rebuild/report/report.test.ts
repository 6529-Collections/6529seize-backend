import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  headline,
  renderMarkdown,
  RunReport,
  statusLine,
  writeReport
} from '@/rebuild/report/report';

function report(parts: Partial<RunReport> = {}): RunReport {
  return {
    verdict: 'PASS',
    scope: 'area-mint',
    mark: 'head',
    final: false,
    startedAt: '2026-11-22T01:00:00.000Z',
    finishedAt: '2026-11-22T01:02:00.000Z',
    backendHead: 'abc1234',
    mysql: { version: '8.0.46', port: 3407 },
    sources: {
      gateway: {
        url: null,
        mode: 'none',
        provenance: null,
        provisional: false
      },
      relays: {
        url: 'ws://127.0.0.1:9',
        mode: 'local',
        provenance: 'the harness relay',
        provisional: true
      }
    },
    classes: {
      INDEX: 2,
      EPHEMERAL: 1,
      PROVIDER: 0,
      SCHEMA: 0,
      VIEW: 0,
      RETIRED: 0,
      EXEMPT: 0
    },
    areas: [
      {
        area: 'mint',
        tables: 3,
        index: 2,
        kept: 1,
        rebuilt: 1,
        pending: 1,
        probes: 2,
        differences: 0,
        unproven: 1,
        seeded: 1,
        failedSteps: 0
      }
    ],
    registryProblems: [],
    pending: [{ area: 'mint', table: 'artists' }],
    planned: [{ area: 'tdh', table: 'tdh_chain_days' }],
    notInSchema: [{ area: 'mint', table: 'meme_lab_royalties' }],
    keptReads: [
      { step: 'mint.team', area: 'mint', table: 'ens', class: 'PROVIDER' }
    ],
    steps: [
      {
        kind: 'rebuilder',
        id: 'mint.team',
        area: 'mint',
        exitCode: 0,
        timedOut: false,
        durationMs: 1500,
        log: 'logs/rebuilder-mint.team.log',
        rowsWritten: { team: 3 },
        guarded: true
      }
    ],
    violations: [],
    probes: { calls: 2, differences: [], unproven: [], unreadTables: [] },
    routes: { documented: 3, probed: 1, waived: 1, open: ['GET /api/x'] },
    tables: {
      rebuilt: ['team'],
      diffs: [
        {
          table: 'team',
          rowsBefore: 3,
          rowsAfter: 3,
          same: true,
          missing: [],
          extra: [],
          changed: []
        }
      ],
      notEmptyAfterDrop: [],
      seededRows: { team: 3, artists: 0 },
      volatileColumns: [
        {
          table: 'team',
          column: 'created_at',
          reason: 'Set when the loop writes the row.'
        }
      ]
    },
    failures: [],
    notes: [],
    ...parts
  };
}

describe('rebuild report', () => {
  it('opens with the scope, the counts and the verdict', () => {
    expect(headline(report())).toEqual([
      'area-mint, mark head, backend abc1234: PASS',
      'tables 3: index 2, ephemeral 1, provider 0, schema 0, view 0, retired 0, exempt 0; rebuilt 1, pending 1, planned 1, differing 0',
      'probes 2: differ 0, unproven 0; INDEX tables no probe read 0',
      'GET routes 3: probed 1, waived 1, open 1',
      'steps 1: failed 0; source violations 0; provisional sources relays'
    ]);
  });

  it('lists failures, differences, unproven probes, violations and pending tables by area', () => {
    const markdown = renderMarkdown(
      report({
        verdict: 'FAIL',
        failures: ['1 probes failed or answer differently'],
        violations: [
          { target: '192.0.2.1:80', pid: 7, at: '2026-11-22T01:01:00.000Z' }
        ],
        probes: {
          calls: 1,
          differences: [
            {
              id: 'mint.team',
              area: 'mint',
              kind: 'failure',
              reason: 'the answers differ',
              before: '200 {"a":1}',
              after: '200 {"a":2}'
            }
          ],
          unproven: [
            {
              id: 'mint.claims',
              area: 'mint',
              kind: 'unproven',
              reason: 'the first pass answered 404',
              before: '404 {"error":"not found"}',
              after: '404 {"error":"not found"}'
            }
          ],
          unreadTables: []
        }
      })
    );
    expect(markdown).toContain('# Rebuild check: FAIL');
    expect(markdown).toContain('- 1 probes failed or answer differently');
    expect(markdown).toContain(
      '- mint.claims (mint): the first pass answered 404: `404 {"error":"not found"}`'
    );
    expect(markdown).toContain('- pid 7 tried 192.0.2.1:80');
    expect(markdown).toContain('- mint.team (mint): the answers differ');
    expect(markdown).toContain('- mint (1): artists');
    expect(markdown).toContain(
      '| mint | 3 | 2 | 1 | 1 | 1 | 1 | 2 | 0 | 1 | 0 |'
    );
    expect(markdown).toContain(
      '- relays: local at ws://127.0.0.1:9, from the harness relay (provisional: a final run fails on it)'
    );
    expect(markdown).toContain('- mint.team (mint) reads ens, PROVIDER');
    expect(markdown).toContain('- tdh (1): tdh_chain_days');
    expect(markdown).toContain('## Tables a fresh schema does not have');
    expect(markdown).toContain(
      '- team.created_at: Set when the loop writes the row.'
    );
    expect(markdown).toContain('- mint (1): meme_lab_royalties');
    expect(markdown).toContain('GET /api/x');
  });

  it('writes the report files and appends one status line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-report-'));
    try {
      const runDir = path.join(dir, 'runs', 'one');
      const status = path.join(dir, 'STATUS.md');
      writeReport(runDir, status, report());
      writeReport(runDir, status, report({ verdict: 'FAIL' }));
      expect(
        JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'))
          .verdict
      ).toBe('FAIL');
      expect(fs.existsSync(path.join(runDir, 'report.md'))).toBe(true);
      const lines = fs.readFileSync(status, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(statusLine(report(), runDir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
