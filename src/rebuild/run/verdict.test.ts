import { judge, PlannedRowsPlan, VerdictInput } from '@/rebuild/run/verdict';

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
  exemptUntil: [],
  sourceProblems: [],
  provisionalSources: [],
  plannedTables: 0,
  plannedSteps: [],
  plannedStepsHere: [],
  orderLeftOut: [],
  unresolvedEdges: [],
  waitingSteps: [],
  staleNeeds: [],
  unownedRows: [],
  unrunOwnedColumns: [],
  plannedRows: [],
  heldProbes: [],
  notInSchema: [],
  openRoutes: 0
};

function plan(
  parts: Partial<PlannedRowsPlan & { table: string }> = {}
): PlannedRowsPlan & { table: string } {
  return {
    table: 'identities',
    step: 'identity.mirror',
    where: 'id > 2',
    reason: 'rows only the derived ids bring',
    until: '2026-12-04',
    change: 'the derived ids',
    seeded: 2,
    missing: 2,
    overdue: false,
    ...parts
  };
}

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
  [
    'needs on tables the schema has',
    {
      staleNeeds: [
        'subs.switch needs identity_chain_principals, which the schema now has: drop the need'
      ]
    },
    /1 needs name tables the schema already has, so they hold nothing back: subs\.switch needs identity_chain_principals/
  ],
  [
    'owned columns no owner rebuilt',
    { unrunOwnedColumns: ['identities.tdh (tdh.rebuild)'] },
    /1 owned columns were left out of the row comparison.*identities\.tdh \(tdh\.rebuild\)/
  ],
  [
    'plans of planned rows',
    { plannedRows: [plan({ seeded: 2, missing: 2 })] },
    /^1 plans of planned rows, seeded rows only a later change rebuilds; a final run fails on every plan: identities by identity\.mirror: seeded 2, missing 2, until 2026-12-04 \(the derived ids\)$/
  ],
  [
    'unresolved cross-area edges',
    { unresolvedEdges: ['waves.chain-mirror before subs.identity'] },
    /^1 unresolved cross-area edges, of every area: order edges to another area's step that isn't in this tree, which a final run fails on: waves\.chain-mirror before subs\.identity$/
  ],
  [
    'steps marked planned whose code is here',
    { plannedStepsHere: ['identity.mirror'] },
    /^1 steps are marked planned though their code is in this tree; drop origin 'planned': identity\.mirror$/
  ],
  [
    'EXEMPT tables with an until',
    {
      exemptUntil: [
        {
          table: 'chain_entry_holds',
          until: '2026-12-04',
          why: 'held entries move later',
          overdue: false
        }
      ]
    },
    /1 EXEMPT tables are exempt only until a day, so a final run fails on them: chain_entry_holds until 2026-12-04 \(held entries move later\)/
  ],
  ['held probes', { heldProbes: ['a.p'] }, /planned probes were held/],
  [
    'tables a fresh schema lacks',
    { notInSchema: ['t'] },
    /not in a fresh schema/
  ]
];

describe('the verdict', () => {
  it('notes an overdue exemption in a normal run and fails it in a final one', () => {
    const overdue = {
      exemptUntil: [
        {
          table: 'chain_entry_holds',
          until: '2026-12-04',
          why: 'held entries move later',
          overdue: true
        }
      ]
    };
    const normal = judge({ ...clean, ...overdue });
    expect(normal.failures).toEqual([]);
    expect(normal.notes).toContain(
      'EXEMPT overdue: chain_entry_holds since 2026-12-04'
    );
    const final = judge({ ...clean, ...overdue, final: true });
    expect(final.failures.join()).toMatch(
      /1 EXEMPT tables are exempt only until a day, so a final run fails on them/
    );
  });

  it('notes a plan that matched no seeded rows, and one whose rows the rebuild writes now', () => {
    const plans = {
      plannedRows: [
        plan({ table: 'a', seeded: 0, missing: 0 }),
        plan({ table: 'b', seeded: 3, missing: 0 }),
        // The run stopped before the rows were compared.
        plan({ table: 'c', seeded: 3, missing: null }),
        plan({ table: 'd', until: '2026-11-01', overdue: true }),
        // Not read: its table isn't in the schema, or its step didn't run.
        plan({ table: 'e', seeded: null, missing: null })
      ]
    };
    const notes = [
      'Planned rows of a by identity.mirror: plan matched no seeded rows',
      'Planned rows of b by identity.mirror: the rebuild writes these rows now: drop the plan'
    ];
    const listed =
      /^5 plans of planned rows.*a by identity\.mirror: seeded 0, missing 0.*c by identity\.mirror: seeded 3, missing not compared.*d by identity\.mirror: seeded 2, missing 2, until 2026-11-01.*e by identity\.mirror: seeded not read, missing not compared/;
    const normal = judge({ ...clean, ...plans });
    expect(normal.failures).toEqual([]);
    expect(normal.notes).toEqual([
      'planned rows overdue: d since 2026-11-01',
      expect.stringMatching(listed),
      ...notes
    ]);
    // A final run fails on every plan, whatever it matched.
    const final = judge({ ...clean, ...plans, final: true });
    expect(final.failures).toEqual([expect.stringMatching(listed)]);
    expect(final.notes).toEqual([
      'planned rows overdue: d since 2026-11-01',
      ...notes
    ]);
  });

  it('lists a column plan with its columns and differing rows, and notes one the rebuild writes now', () => {
    const columns = {
      columns: ['updated_at', 'cancelled_at'],
      differingByColumn: { updated_at: 3 }
    };
    const plans = {
      plannedRows: [
        plan({
          table: 'competitions',
          ...columns,
          differing: 3,
          excused: 2,
          missing: 0
        }),
        plan({
          table: 'waves',
          ...columns,
          differing: 0,
          excused: 0,
          missing: 0
        }),
        // Rows missing: the plan still matters, though none came back changed.
        plan({
          table: 'drops',
          ...columns,
          differing: 0,
          excused: 0,
          missing: 2
        })
      ]
    };
    const normal = judge({ ...clean, ...plans });
    expect(normal.notes).toEqual([
      expect.stringMatching(
        /^3 plans of planned rows.*competitions columns updated_at, cancelled_at by identity\.mirror: seeded 2, differing 3, excused 2, missing 0, until 2026-12-04 \(the derived ids\); waves columns updated_at, cancelled_at by identity\.mirror: seeded 2, differing 0, excused 0, missing 0.*drops columns updated_at, cancelled_at by identity\.mirror: seeded 2, differing 0, excused 0, missing 2/
      ),
      'Planned columns of waves by identity.mirror: the rebuild writes these columns now: drop the plan'
    ]);
    expect(judge({ ...clean, ...plans, final: true }).failures).toEqual([
      expect.stringMatching(/^3 plans of planned rows/)
    ]);
  });

  it('notes the planned writes left out of the order check, in every run', () => {
    const finding = { orderLeftOut: ['waves.mirror (waves_mirror, drops)'] };
    const note =
      '1 planned rebuilders, of every area, had their writes left out of the order check while their module is not in this tree: waves.mirror (waves_mirror, drops)';
    expect(judge({ ...clean, ...finding })).toEqual({
      failures: [],
      notes: [note]
    });
    expect(judge({ ...clean, ...finding, final: true })).toEqual({
      failures: [],
      notes: [note]
    });
  });

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
