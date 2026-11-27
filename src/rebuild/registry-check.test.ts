import * as fc from 'fast-check';
import {
  AreaManifest,
  RebuildStep,
  TableEntry
} from '@/rebuild/manifest.types';
import { checkRegistry } from '@/rebuild/registry-check';
import { CodeOrigin } from '@/rebuild/table-discovery';

function area(
  name: string,
  tables: Record<string, TableEntry>,
  parts: Partial<AreaManifest> = {}
): AreaManifest {
  return {
    area: name,
    flags: {},
    tables,
    seeds: [],
    rebuilders: [],
    probes: [],
    ...parts
  };
}

function code(...names: string[]): Map<string, Set<CodeOrigin>> {
  return new Map(names.map((name) => [name, new Set<CodeOrigin>(['entity'])]));
}

const index = (): TableEntry => ({ class: 'INDEX' });

function step(id: string, parts: Partial<RebuildStep> = {}): RebuildStep {
  return {
    id,
    run: { module: 'src/x', exportName: 'run' },
    writes: [],
    sources: ['ethereum'],
    timeoutMinutes: 5,
    ...parts
  };
}

describe('checkRegistry', () => {
  it('passes when every code table is in exactly one manifest', () => {
    const result = checkRegistry({
      manifests: [area('a', { t1: index() }), area('b', { t2: index() })],
      codeTables: code('t1', 't2')
    });
    expect(result.problems).toEqual([]);
    expect(result.pending).toEqual([
      { area: 'a', table: 't1' },
      { area: 'b', table: 't2' }
    ]);
    expect(result.classes.INDEX).toBe(2);
  });

  it('reports a table in no manifest, in two, or named nowhere in code', () => {
    const result = checkRegistry({
      manifests: [
        area('a', { t1: index(), stale: index() }),
        area('b', { t1: index() })
      ],
      codeTables: code('t1', 'missing')
    });
    expect(result.problems.map((p) => [p.kind, p.table])).toEqual([
      ['MISSING', 'missing'],
      ['DOUBLE', 't1'],
      ['STALE', 'stale']
    ]);
  });

  it('accepts a runtime table that code never names', () => {
    const result = checkRegistry({
      manifests: [
        area('a', {
          typeorm_metadata: {
            class: 'SCHEMA',
            why: 'TypeORM metadata',
            origin: 'runtime'
          }
        })
      ],
      codeTables: code()
    });
    expect(result.problems).toEqual([]);
  });

  it('accepts a planned table until its code arrives, and lists it', () => {
    const planned: TableEntry = { ...index(), origin: 'planned' };
    const before = checkRegistry({
      manifests: [area('a', { new_table: planned })],
      codeTables: code()
    });
    expect(before.problems).toEqual([]);
    expect(before.plannedAbsent).toEqual([{ area: 'a', table: 'new_table' }]);
    const after = checkRegistry({
      manifests: [area('a', { new_table: planned })],
      codeTables: code('new_table')
    });
    expect(after.plannedAbsent).toEqual([]);
  });

  it('requires a reason for every kept class', () => {
    const result = checkRegistry({
      manifests: [area('a', { t1: { class: 'EPHEMERAL' } })],
      codeTables: code('t1')
    });
    expect(result.problems.map((p) => p.kind)).toEqual(['NO_REASON']);
  });

  it('checks the live schema against the classes', () => {
    const result = checkRegistry({
      manifests: [
        area('a', {
          old: { class: 'RETIRED', why: 'retired' },
          v: { class: 'VIEW', why: 'view' },
          t: index()
        })
      ],
      codeTables: code('old', 'v', 't'),
      liveTables: [
        { name: 'old', type: 'BASE TABLE' },
        { name: 'v', type: 'BASE TABLE' },
        { name: 't', type: 'VIEW' },
        { name: 'runtime_only', type: 'BASE TABLE' }
      ]
    });
    expect(result.problems.map((p) => [p.kind, p.table])).toEqual([
      ['MISSING', 'runtime_only'],
      ['WRONG_CLASS', 'old'],
      ['WRONG_CLASS', 'v'],
      ['WRONG_CLASS', 't']
    ]);
  });

  it('lets a rebuilder write only its own INDEX tables', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          {
            mine: index(),
            kept: { class: 'EPHEMERAL', why: 'queue' }
          },
          {
            rebuilders: [step('a.one', { writes: ['mine', 'kept', 'theirs'] })]
          }
        ),
        area('b', { theirs: index() })
      ],
      codeTables: code('mine', 'kept', 'theirs')
    });
    expect(result.problems.map((p) => [p.kind, p.table])).toEqual([
      ['BAD_STEP', 'kept'],
      ['BAD_STEP', 'theirs']
    ]);
    expect(result.pending).toEqual([{ area: 'b', table: 'theirs' }]);
  });

  it('reports unknown reads, repeated ids, two writers and cycles', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { t1: index() },
          {
            rebuilders: [
              step('one', { writes: ['t1'], reads: ['nope'], after: ['two'] }),
              step('two', { writes: ['t1'], after: ['one'] }),
              step('three', { after: ['ghost'], timeoutMinutes: 0 }),
              step('three')
            ]
          }
        )
      ],
      codeTables: code('t1')
    });
    expect(
      result.problems
        .map((p) => p.kind)
        .sort((a, b) => (a < b ? -1 : Number(a > b)))
    ).toEqual([
      'BAD_ORDER',
      'BAD_ORDER',
      'BAD_STEP',
      'BAD_STEP',
      'BAD_STEP',
      'DOUBLE_WRITER'
    ]);
  });

  it('keeps last to seeds, and never lets a seed that is not last wait on one', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { t1: index() },
          {
            seeds: [
              step('a.seed'),
              step('a.catch-up', { after: ['a.seed'], last: true }),
              step('a.after-catch-up', { after: ['a.catch-up'] }),
              step('a.last-too', { after: ['a.catch-up'], last: true }),
              // A seed may run before a last one, never a last one before
              // a seed that isn't.
              step('a.early', { before: ['a.seed', 'a.catch-up'] }),
              step('a.last-first', { before: ['a.seed'], last: true })
            ],
            rebuilders: [step('a.rebuild', { writes: ['t1'], last: true })]
          }
        )
      ],
      codeTables: code('t1')
    });
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
      ['BAD_STEP', 'rebuilder a.rebuild is marked last; only seeds run last'],
      [
        'BAD_ORDER',
        'seed a.after-catch-up waits on last seed a.catch-up; mark it last too'
      ],
      [
        'BAD_ORDER',
        "last seed a.last-first runs before seed a.seed, which isn't last; mark it last too"
      ]
    ]);
  });

  it('takes a writer that runs before its reader as ordered', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { t1: index(), t2: index() },
          {
            rebuilders: [
              step('a.reader', { writes: ['t2'], reads: ['t1'] }),
              step('a.writer', { writes: ['t1'], before: ['a.reader'] }),
              step('a.ghost', { writes: [], before: ['nowhere'] })
            ]
          }
        )
      ],
      codeTables: code('t1', 't2')
    });
    expect(result.problems.map((p) => p.detail)).toEqual([
      'rebuilder a.ghost lists unknown step nowhere in `before`'
    ]);
  });

  it('names the field an unknown step comes from', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { t1: index() },
          {
            seeds: [
              step('a.seed', { after: ['a.gone'] }),
              step('a.seed-too', { after: ['a.gone'] }),
              step('a.early', { before: ['a.gone'] })
            ],
            rebuilders: [
              step('a.rebuild', { writes: ['t1'], after: ['a.missing'] })
            ]
          }
        )
      ],
      codeTables: code('t1')
    });
    expect(
      result.problems.filter((p) => p.kind === 'BAD_ORDER').map((p) => p.detail)
    ).toEqual([
      'a seed waits on unknown step a.gone',
      'seed a.early lists unknown step a.gone in `before`',
      'a rebuilder waits on unknown step a.missing'
    ]);
  });

  describe('partitioned writers', () => {
    const write = (table: string, columns: string[], values: string[][]) => ({
      table,
      partition: { columns, values, reason: 'its records' }
    });
    const check = (
      a: RebuildStep['writes'],
      b: RebuildStep['writes'],
      seeds: RebuildStep[] = []
    ) =>
      checkRegistry({
        manifests: [
          area(
            'a',
            { heads: index() },
            {
              seeds,
              rebuilders: [step('a.rebuild', { writes: a })]
            }
          ),
          // b writes a partition of a's table.
          area('b', {}, { rebuilders: [step('b.rebuild', { writes: b })] })
        ],
        codeTables: code('heads')
      }).problems.map((p) => [p.kind, p.detail]);
    const cols = ['family', 'type'];

    it('lets two rebuilders write disjoint partitions of one table', () => {
      expect(
        check(
          [
            write('heads', cols, [
              ['pv', 'follow'],
              ['pv', '~keys']
            ])
          ],
          [write('heads', cols, [['ps', '~keys']])]
        )
      ).toEqual([]);
    });

    it('refuses overlapping partitions, a whole writer beside one, and other columns', () => {
      expect(
        check(
          [write('heads', cols, [['ps', '~keys']])],
          [write('heads', cols, [['ps', '~keys']])]
        )
      ).toEqual([
        [
          'DOUBLE_WRITER',
          "heads's partitions overlap: a.rebuild and b.rebuild both write (family, type) ('ps', '~keys')"
        ]
      ]);
      // Folded as the default collation folds: case and accents, while
      // trailing spaces count (NO PAD).
      expect(
        check(
          [
            write('heads', cols, [
              ['ps', '~keys'],
              ['pv', 'a']
            ])
          ],
          [
            write('heads', cols, [
              ['PS', '~K\u00e9ys'],
              ['pv', 'a ']
            ])
          ]
        )
      ).toEqual([
        [
          'DOUBLE_WRITER',
          "heads's partitions overlap: a.rebuild and b.rebuild both write (family, type) ('PS', '~K\u00e9ys')"
        ]
      ]);
      expect(
        check(['heads'], [write('heads', cols, [['ps', '~keys']])])
      ).toEqual([
        [
          'DOUBLE_WRITER',
          'heads is written by a.rebuild, b.rebuild; with more than one writer, each writes a partition'
        ]
      ]);
      expect(
        check(
          [write('heads', ['type'], [['~keys']])],
          [write('heads', cols, [['ps', '~keys']])]
        )
      ).toEqual([
        [
          'DOUBLE_WRITER',
          "heads's writers partition it on different columns: (type) by a.rebuild, (family, type) by b.rebuild"
        ]
      ]);
    });

    it("checks a partition is well formed and a rebuilder's", () => {
      expect(
        check(
          [write('heads', cols, [['pv']])],
          [write('heads', [], [])],
          [step('a.seed', { writes: [write('heads', cols, [['x', 'y']])] })]
        ).map(([, detail]) => detail)
      ).toEqual([
        "seed a.seed declares a partition of heads; only a rebuilder's write has one",
        "rebuilder a.rebuild's partition of heads has a value that doesn't match its 2 columns",
        "rebuilder b.rebuild's partition of heads names no columns",
        "rebuilder b.rebuild's partition of heads has no values",
        "heads's writers partition it on different columns: (family, type) by a.rebuild, () by b.rebuild"
      ]);
    });
  });

  it('keeps a checkpoint to INDEX tables, with a column and a reason', () => {
    const result = checkRegistry({
      manifests: [
        area('a', {
          good: {
            class: 'INDEX',
            checkpoint: { column: 'block', reason: 'readers take MAX(block)' }
          },
          kept: {
            class: 'EPHEMERAL',
            why: 'a cache',
            checkpoint: { column: 'block', reason: 'x' }
          },
          bare: { class: 'INDEX', checkpoint: { column: ' ', reason: ' ' } }
        })
      ],
      codeTables: code('good', 'kept', 'bare')
    });
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
      [
        'BAD_CHECKPOINT',
        'kept is EPHEMERAL; only an INDEX table has a checkpoint'
      ],
      ['BAD_CHECKPOINT', "bare's checkpoint names no column"],
      ['BAD_CHECKPOINT', "bare's checkpoint has no reason"]
    ]);
  });

  it('lets a step wait only for a table a later branch adds, with a reason', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          {
            t1: index(),
            later: { class: 'INDEX', origin: 'planned' },
            // Named in code with no entity behind it yet.
            named: index(),
            v: { class: 'VIEW', why: 'a facade view' }
          },
          {
            seeds: [
              step('a.seed', {
                writes: ['t1'],
                needs: [
                  { table: 'later', reason: 'a later branch creates it' },
                  { table: 'named', reason: ' ' },
                  { table: 'nope', reason: 'x' },
                  { table: 't1', reason: 'x' },
                  { table: 'v', reason: 'x' }
                ]
              })
            ]
          }
        )
      ],
      codeTables: new Map([
        ...Array.from(code('t1')),
        ['named', new Set<CodeOrigin>(['constant'])],
        ['v', new Set<CodeOrigin>(['view'])]
      ])
    });
    expect(result.problems.map((p) => p.detail)).toEqual([
      'seed a.seed needs named without a reason',
      'seed a.seed needs unknown table nope',
      'seed a.seed needs v, a VIEW table, never one a branch adds'
    ]);
  });

  it('lets a step need a table whether or not an entity in the tree creates it', () => {
    // The same branch, on a tree without the table's entity (it waits) and
    // on one with it (the run notes the need as one to drop).
    const check = (codeTables: Map<string, Set<CodeOrigin>>) =>
      checkRegistry({
        manifests: [
          area(
            'a',
            { t1: index() },
            { seeds: [step('a.seed', { writes: ['t1'] })] }
          ),
          area(
            'b',
            { mirror: { class: 'INDEX', origin: 'planned' } },
            {
              rebuilders: [
                step('b.copy', {
                  writes: [],
                  needs: [{ table: 'mirror', reason: 'the mirror creates it' }]
                })
              ]
            }
          )
        ],
        codeTables
      }).problems.map((p) => p.detail);
    expect(check(code('t1'))).toEqual([]);
    expect(check(code('t1', 'mirror'))).toEqual([]);
  });

  it('checks probe ids, paths, placeholders and reasons', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          {},
          {
            probes: [
              { id: 'p', path: '/api/profiles/{handle}' },
              { id: 'p', path: 'api/x' },
              {
                id: 'q',
                path: '/api/x/{id}',
                each: { id: ['1'] },
                ignore: [{ path: '$.time', reason: ' ' }]
              }
            ]
          }
        )
      ],
      codeTables: code()
    });
    expect(result.problems.map((p) => p.detail)).toEqual([
      'probe p has no values for {handle}',
      'probe id p is used twice',
      'probe p path must start with /',
      'probe q leaves out $.time without a reason'
    ]);
  });

  it("makes a rebuilder that reads another rebuilder's table wait for it", () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { keys: index() },
          { rebuilders: [step('a.keys', { writes: ['keys'] })] }
        ),
        area(
          'b',
          { held: index(), ordered: index() },
          {
            rebuilders: [
              step('b.held', { writes: ['held'], reads: ['keys'] }),
              step('b.ordered', {
                writes: ['ordered'],
                reads: ['keys'],
                after: ['a.keys']
              })
            ]
          }
        )
      ],
      codeTables: code('keys', 'held', 'ordered')
    });
    expect(result.problems.map((p) => p.detail)).toEqual([
      "rebuilder b.held reads keys, which a.keys rebuilds; add after: ['a.keys']"
    ]);
  });

  it('refuses a seed that needs a last seed unless it is last too', () => {
    const need = { step: 'a.last', reason: 'it catches up' };
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          {},
          {
            seeds: [
              step('a.last', { last: true }),
              step('a.early', { needsSteps: [need] }),
              step('a.late', { needsSteps: [need], last: true })
            ]
          }
        )
      ],
      codeTables: code()
    });
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
      ['BAD_ORDER', 'seed a.early needs last seed a.last; mark it last too']
    ]);
  });

  it('checks the steps a step needs', () => {
    const need = (stepId: string, reason = 'a reason') => ({
      step: stepId,
      reason
    });
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { t1: index() },
          {
            seeds: [
              step('a.seed'),
              step('a.needs-seed', { needsSteps: [need('a.seed')] }),
              step('a.needs-rebuilder', { needsSteps: [need('a.rebuild')] }),
              step('a.needs-itself', { needsSteps: [need('a.needs-itself')] }),
              step('a.needs-nothing-known', {
                needsSteps: [need('a.nowhere'), need('a.seed', ' ')]
              })
            ],
            rebuilders: [
              step('a.rebuild', { writes: ['t1'] }),
              step('a.needs-both', {
                needsSteps: [need('a.seed'), need('a.rebuild')]
              })
            ]
          }
        )
      ],
      codeTables: code('t1')
    });
    // The whole list: a step that needs itself is refused once, not also
    // as a cycle.
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
      [
        'BAD_ORDER',
        'seed a.needs-rebuilder needs rebuilder a.rebuild; every seed runs before the rebuilders'
      ],
      ['BAD_ORDER', 'seed a.needs-itself needs itself'],
      ['BAD_ORDER', 'seed a.needs-nothing-known needs unknown step a.nowhere'],
      [
        'BAD_STEP',
        'seed a.needs-nothing-known needs step a.seed without a reason'
      ]
    ]);
  });

  it("refuses flags that would set the run's own variables", () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          {},
          {
            flags: {
              FEATURE_X: 'true',
              DB_HOST: 'elsewhere',
              REBUILD_ALLOWED_ENDPOINTS: '*',
              ETHEREUM_RPC_URL: 'http://192.0.2.1',
              ALCHEMY_API_KEY: 'k'
            }
          }
        )
      ],
      codeTables: code()
    });
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual(
      [
        'DB_HOST',
        'REBUILD_ALLOWED_ENDPOINTS',
        'ETHEREUM_RPC_URL',
        'ALCHEMY_API_KEY'
      ].map((name) => [
        'BAD_FLAG',
        `flag ${name} would set one of the run's own variables`
      ])
    );
  });

  it('checks what a planned probe waits for', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          { t1: index() },
          {
            probes: [
              { id: 'held', path: '/x', origin: 'planned', needs: ['t1'] },
              { id: 'none', path: '/x', origin: 'planned' },
              { id: 'unplanned', path: '/x', needs: ['t1'] },
              { id: 'unknown', path: '/x', origin: 'planned', needs: ['t9'] }
            ]
          }
        )
      ],
      codeTables: code('t1')
    });
    expect(result.problems.map((p) => p.detail)).toEqual([
      'planned probe none names no tables it waits for',
      "probe unplanned names tables it waits for but isn't planned",
      'probe unknown waits for unknown table t9'
    ]);
  });

  it('finds every missing and doubled table for any split into areas', () => {
    const names = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), {
      minLength: 1,
      maxLength: 20
    });
    fc.assert(
      fc.property(
        names,
        fc.array(fc.integer({ min: -1, max: 2 }), { maxLength: 20 }),
        (tables, owners) => {
          const areas: Record<string, TableEntry>[] = [{}, {}];
          tables.forEach((table, i) => {
            const owner = owners[i] ?? 0;
            if (owner === 0 || owner === 2) areas[0][table] = index();
            if (owner === 1 || owner === 2) areas[1][table] = index();
          });
          const result = checkRegistry({
            manifests: [area('a', areas[0]), area('b', areas[1])],
            codeTables: code(...tables)
          });
          const kinds = (kind: string) =>
            result.problems
              .filter((p) => p.kind === kind)
              .map((p) => p.table)
              .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
          const expected = (owner: number) =>
            tables
              .filter((_, i) => (owners[i] ?? 0) === owner)
              .sort((a, b) => a.localeCompare(b));
          expect(kinds('MISSING')).toEqual(expected(-1));
          expect(kinds('DOUBLE')).toEqual(expected(2));
        }
      )
    );
  });
});
