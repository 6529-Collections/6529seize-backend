import { judge, VerdictInput } from '@/rebuild/run/verdict';

const clean: VerdictInput = {
  final: false,
  stepViolations: 0,
  apiViolations: 0,
  unguardedSteps: [],
  differences: 0,
  unproven: 0,
  pending: 0,
  unreadTables: [],
  differingTables: 0,
  unseededTables: [],
  exemptTables: 0,
  sourceProblems: [],
  provisionalSources: [],
  plannedTables: 0,
  plannedSteps: [],
  waitingSteps: [],
  unownedRows: [],
  heldProbes: [],
  notInSchema: [],
  openRoutes: 0
};

/** One finding at a time, in a normal run and in a final one. */
const findings: [string, Partial<VerdictInput>, RegExp][] = [
  [
    'rows that differ',
    { differingTables: 2 },
    /2 rebuilt tables differ row by row/
  ],
  [
    'unseeded rebuilt tables',
    { unseededTables: ['t'] },
    /had no rows after the seeds/
  ],
  [
    "command steps the guard can't watch",
    { unguardedSteps: ['s'] },
    /don't run Node/
  ],
  ['unproven probes', { unproven: 3 }, /3 probes answered 4xx or with no data/],
  ['pending tables', { pending: 4 }, /4 INDEX tables have no rebuilder/],
  [
    'provisional sources',
    { provisionalSources: ['relays'] },
    /Provisional sources/
  ],
  [
    'planned tables',
    { plannedTables: 1 },
    /planned tables are not in this tree/
  ],
  [
    'skipped planned steps',
    { plannedSteps: ['a.seed'] },
    /planned steps were skipped/
  ],
  [
    'steps waiting for a table',
    {
      waitingSteps: [
        { step: 'a.seed', table: 't', reason: 'a later branch creates it' }
      ]
    },
    /1 steps were skipped as planned because a table they need is not in the schema yet.*a\.seed needs t \(a later branch creates it\)/
  ],
  [
    'rows no partition owns',
    { unownedRows: ["heads (1 rows whose type is in no writer's partition)"] },
    /1 partitioned tables hold rows no rebuilder owns after the seeds: heads/
  ],
  ['held probes', { heldProbes: ['a.p'] }, /planned probes were held/],
  [
    'tables a fresh schema lacks',
    { notInSchema: ['t'] },
    /not in a fresh schema/
  ]
];

describe('the verdict', () => {
  it('passes a clean run with nothing to note', () => {
    expect(judge(clean)).toEqual({ failures: [], notes: [] });
    expect(judge({ ...clean, final: true })).toEqual({
      failures: [],
      notes: []
    });
  });

  it.each(findings)(
    'notes %s, and fails a final run on them',
    (_name, finding, text) => {
      const normal = judge({ ...clean, ...finding });
      expect(normal.failures).toEqual([]);
      expect(normal.notes).toEqual([expect.stringMatching(text)]);
      const final = judge({ ...clean, ...finding, final: true });
      expect(final.failures).toEqual([expect.stringMatching(text)]);
      expect(final.notes).toEqual([]);
    }
  );

  it('fails every run on differences, source problems and outside connections', () => {
    const verdict = judge({
      ...clean,
      differences: 1,
      sourceProblems: ['gateway: 1 requests not in the recording'],
      stepViolations: 2
    });
    expect(verdict.failures).toEqual([
      '2 connections to sources outside the list (see Source violations)',
      '1 probes failed or answer differently',
      'gateway: 1 requests not in the recording'
    ]);
  });

  it('fails only a final run on unread rebuilt tables and open routes', () => {
    const finding = { unreadTables: ['t'], openRoutes: 5 };
    expect(judge({ ...clean, ...finding }).failures).toEqual([]);
    expect(judge({ ...clean, ...finding, final: true }).failures).toEqual([
      '1 rebuilt tables were read by no probe',
      '5 documented GET routes have no probe and no waiver'
    ]);
  });

  it("says a skipped step's tables were kept only when the run kept them", () => {
    const finding = {
      plannedSteps: ['a.seed'],
      waitingSteps: [{ step: 'b.rebuild', table: 't', reason: 'later' }]
    };
    const notes = judge({ ...clean, ...finding }).notes.join(' ');
    expect(notes).toContain("their rebuilders' tables were kept");
    const failures = judge({ ...clean, ...finding, final: true }).failures;
    expect(failures.join(' ')).toContain(
      "their rebuilders' tables were not rebuilt"
    );
    expect(failures.join(' ')).not.toContain('were kept');
  });
});
