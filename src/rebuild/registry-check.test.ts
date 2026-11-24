import * as fc from 'fast-check';
import {
  AreaManifest,
  PlannedRows,
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
      'a rebuilder waits on unknown step nowhere'
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

  describe('column owners', () => {
    const owner = (
      id: string,
      columns: string[],
      parts: Partial<RebuildStep> = {}
    ) =>
      step(id, {
        writes: [{ table: 'ids', columns, reason: 'its sync writes them' }],
        ...parts
      });
    const check = (rebuilders: RebuildStep[], seeds: RebuildStep[] = []) =>
      checkRegistry({
        manifests: [
          area(
            'a',
            { ids: index() },
            {
              rebuilders: rebuilders.filter((s) => s.id.startsWith('a.')),
              seeds
            }
          ),
          area(
            'b',
            {},
            {
              rebuilders: rebuilders.filter((s) => s.id.startsWith('b.'))
            }
          )
        ],
        codeTables: code('ids')
      }).problems.map((p) => [p.kind, p.detail]);
    const rows = step('a.rows', { writes: ['ids'] });

    it("lets another area own columns of a row writer's table, after it", () => {
      expect(
        check([rows, owner('b.tdh', ['tdh', 'xtdh'], { after: ['a.rows'] })])
      ).toEqual([]);
    });

    it('refuses overlapping owners, an owner with no row writer, and one that runs first', () => {
      expect(
        check([
          rows,
          owner('b.tdh', ['tdh'], { after: ['a.rows'] }),
          owner('b.again', ['tdh', 'level'], { after: ['a.rows'] })
        ])
      ).toEqual([
        [
          'DOUBLE_WRITER',
          "ids's column owners overlap: b.tdh and b.again both own tdh"
        ]
      ]);
      expect(check([owner('b.tdh', ['tdh'])])).toEqual([
        ['DOUBLE_WRITER', 'ids has column owners (b.tdh) but no row writer']
      ]);
      expect(check([rows, owner('b.tdh', ['tdh'])])).toEqual([
        [
          'BAD_ORDER',
          "column owner b.tdh of ids must run after its row writer; add after: ['a.rows']"
        ]
      ]);
    });

    it('lets a writer read its table without waiting on the column owners', () => {
      // The row writer reads its rows, and two owners read the table: none
      // waits on an owner, and each owner waits on the row writer only.
      expect(
        check([
          step('a.rows', { writes: ['ids'], reads: ['ids'] }),
          owner('b.tdh', ['tdh'], { after: ['a.rows'], reads: ['ids'] }),
          owner('b.xtdh', ['xtdh'], { after: ['a.rows'], reads: ['ids'] })
        ])
      ).toEqual([]);
      // Another reader of the table waits on every writer of it.
      expect(
        check([
          rows,
          owner('b.tdh', ['tdh'], { after: ['a.rows'] }),
          step('b.reader', { reads: ['ids'], after: ['a.rows'] })
        ])
      ).toEqual([
        [
          'BAD_ORDER',
          "rebuilder b.reader reads ids, which b.tdh rebuilds; add after: ['b.tdh']"
        ]
      ]);
    });

    it('refuses a step that writes the rows and owns columns of one table', () => {
      expect(
        check([
          step('a.rows', {
            writes: ['ids', { table: 'ids', columns: ['tdh'], reason: 'x' }]
          })
        ])
      ).toEqual([
        [
          'DOUBLE_WRITER',
          'a.rows both writes the rows of ids and owns columns of it; a step does one or the other'
        ]
      ]);
    });

    it('refuses a write with both columns and a partition, and owning a partition or checkpoint column', () => {
      const both = {
        table: 'ids',
        columns: ['tdh'],
        reason: 'x',
        partition: { columns: ['kind'], values: [['a']], reason: 'x' }
      };
      expect(
        check([
          rows,
          step('b.both', { writes: [both], after: ['a.rows'] })
        ]).map(([, detail]) => detail)
      ).toContain(
        'rebuilder b.both declares both columns and a partition of ids; a write is one or the other'
      );
      const partitioned = (id: string, value: string) =>
        step(id, {
          writes: [
            {
              table: 'ids',
              partition: { columns: ['kind'], values: [[value]], reason: 'x' }
            }
          ]
        });
      expect(
        check([
          partitioned('a.one', 'a'),
          partitioned('a.two', 'b'),
          owner('b.kind', ['kind'], { after: ['a.one', 'a.two'] })
        ])
      ).toEqual([
        [
          'DOUBLE_WRITER',
          'b.kind owns ids.kind, which says which rows are which (a partition or checkpoint column); only the row writer writes it'
        ]
      ]);
      expect(
        checkRegistry({
          manifests: [
            area(
              'a',
              {
                ids: {
                  class: 'INDEX',
                  checkpoint: { column: 'block', reason: 'the newest row' }
                }
              },
              {
                rebuilders: [
                  rows,
                  step('a.block', {
                    writes: [{ table: 'ids', columns: ['block'], reason: 'x' }],
                    after: ['a.rows']
                  })
                ]
              }
            )
          ],
          codeTables: code('ids')
        }).problems.map((p) => p.detail)
      ).toEqual([
        'a.block owns ids.block, which says which rows are which (a partition or checkpoint column); only the row writer writes it'
      ]);
    });

    it("refuses an owner of a table that isn't INDEX, or without a reason", () => {
      expect(
        checkRegistry({
          manifests: [
            area(
              'a',
              { ids: index(), cache: { class: 'EPHEMERAL', why: 'a cache' } },
              {
                rebuilders: [
                  rows,
                  step('a.cache', {
                    writes: [{ table: 'cache', columns: ['x'], reason: 'x' }]
                  }),
                  owner('a.bare', ['tdh'], { after: ['a.rows'] })
                ].map((s) =>
                  s.id === 'a.bare'
                    ? {
                        ...s,
                        writes: [
                          { table: 'ids', columns: ['tdh'], reason: ' ' }
                        ]
                      }
                    : s
                )
              }
            )
          ],
          codeTables: code('ids', 'cache')
        }).problems.map((p) => p.detail)
      ).toEqual([
        'rebuilder a.cache owns columns of cache, not an INDEX table',
        "rebuilder a.bare's columns of ids have no reason",
        'cache has column owners (a.cache) but no row writer'
      ]);
    });

    it('checks an owner is a rebuilder with columns and a reason', () => {
      expect(
        check(
          [rows, owner('b.none', [], { after: ['a.rows'] })],
          [owner('a.seed', ['tdh'])]
        ).map(([, detail]) => detail)
      ).toEqual([
        'seed a.seed declares columns of ids; only a rebuilder owns columns',
        "rebuilder b.none's columns of ids name no columns"
      ]);
    });
  });

  it('keeps planned rows to a rebuilder of the rows, with where, reason, a last day and a change', () => {
    const plan = (parts: Partial<PlannedRows> = {}): PlannedRows => ({
      table: 'ids',
      where: 'NOT EXISTS (SELECT 1 FROM map m WHERE m.id = ids.id)',
      reason: 'rows only a later step creates',
      until: '2026-12-04',
      change: 'the derived ids',
      ...parts
    });
    const check = (rebuilders: RebuildStep[], seeds: RebuildStep[] = []) =>
      checkRegistry({
        manifests: [
          area('a', { ids: index(), other: index() }, { rebuilders, seeds })
        ],
        codeTables: code('ids', 'other')
      }).problems.map((p) => p.detail);
    expect(
      check([step('a.rows', { writes: ['ids'], plannedRows: [plan()] })])
    ).toEqual([]);
    expect(
      check(
        [
          step('a.rows', {
            writes: ['ids'],
            plannedRows: [
              plan({ table: 'other' }),
              plan({ where: ' ', reason: '', until: 'the derived ids' }),
              plan({ until: '2026-1-5', change: ' ' }),
              // A manifest written without the type's help.
              { table: 'ids' } as PlannedRows
            ]
          })
        ],
        [step('a.seed', { writes: ['ids'], plannedRows: [plan()] })]
      )
    ).toEqual([
      'seed a.seed plans rows of ids; only a rebuilder plans rows',
      "rebuilder a.rows plans rows of other, whose rows it doesn't write",
      "rebuilder a.rows's planned rows of ids have no where",
      "rebuilder a.rows's planned rows of ids have no reason",
      "rebuilder a.rows's planned rows of ids need an until, their last day written YYYY-MM-DD",
      "rebuilder a.rows's planned rows of ids need an until, their last day written YYYY-MM-DD",
      "rebuilder a.rows's planned rows of ids name no change that brings their source",
      "rebuilder a.rows's planned rows of ids have no where",
      "rebuilder a.rows's planned rows of ids have no reason",
      "rebuilder a.rows's planned rows of ids need an until, their last day written YYYY-MM-DD",
      "rebuilder a.rows's planned rows of ids name no change that brings their source"
    ]);
  });

  it("keeps a plan's columns to plain names, each once, that no other rebuilder owns", () => {
    const plan = (columns: string[]): PlannedRows => ({
      table: 'ids',
      where: 'id > 2',
      reason: 'columns a later change rebuilds',
      until: '2026-12-04',
      change: 'the derived ids',
      columns
    });
    const check = (plans: PlannedRows[]) =>
      checkRegistry({
        manifests: [
          area(
            'a',
            { ids: index() },
            {
              rebuilders: [
                step('a.rows', { writes: ['ids'], plannedRows: plans }),
                step('a.ranks', {
                  writes: [
                    { table: 'ids', columns: ['rank'], reason: 'ranks' }
                  ],
                  after: ['a.rows']
                })
              ]
            }
          )
        ],
        codeTables: code('ids')
      }).problems.map((p) => p.detail);
    expect(check([plan(['name', 'updated_at'])])).toEqual([]);
    expect(
      check([plan([]), plan(['a b', 'name', 'name']), plan(['rank', 'name'])])
    ).toEqual([
      "rebuilder a.rows's planned columns of ids name none",
      "rebuilder a.rows's planned columns of ids name 'a b', not a plain column name",
      "rebuilder a.rows's planned columns of ids name a column twice",
      "rebuilder a.rows's planned columns of ids include rank, which a.ranks owns"
    ]);
  });

  describe('order edges to another area', () => {
    const check = (writer: Partial<RebuildStep>, readers: RebuildStep[] = []) =>
      checkRegistry({
        manifests: [
          area(
            'waves',
            { waves: index() },
            {
              rebuilders: [
                step('waves.mirror', { writes: ['waves'], ...writer })
              ]
            }
          ),
          area('subs', { subs: index() }, { rebuilders: readers })
        ],
        codeTables: code('waves', 'subs')
      });

    it('notes an edge to a step of another known area that is not here', () => {
      const result = check({ before: ['subs.identity'], after: ['subs.seed'] });
      expect(result.problems).toEqual([]);
      expect(result.crossAreaEdges).toEqual([
        { step: 'waves.mirror', field: 'after', id: 'subs.seed' },
        { step: 'waves.mirror', field: 'before', id: 'subs.identity' }
      ]);
    });

    it("still fails an unknown id of the step's own area, or of no area", () => {
      const result = check({ before: ['waves.ghost', 'sbus.identity'] });
      expect(result.problems.map((p) => p.detail)).toEqual([
        'a rebuilder waits on unknown step waves.ghost',
        'a rebuilder waits on unknown step sbus.identity'
      ]);
      expect(result.crossAreaEdges).toEqual([]);
    });

    it('checks a resolved edge in full', () => {
      const reader = step('subs.identity', {
        writes: ['subs'],
        reads: ['waves']
      });
      // The writer's before orders the reader after it: no problem.
      expect(check({ before: ['subs.identity'] }, [reader]).problems).toEqual(
        []
      );
      // Without it, the read of a table the writer rebuilds fails.
      expect(check({}, [reader]).problems.map((p) => p.kind)).toEqual([
        'BAD_ORDER'
      ]);
      // And an edge both ways is a cycle.
      expect(
        check({ before: ['subs.identity'] }, [
          { ...reader, before: ['waves.mirror'] }
        ]).problems.map((p) => p.detail)
      ).toEqual(['rebuilders wait on each other: waves.mirror, subs.identity']);
    });
  });

  it('refuses an id a seed and a rebuilder share', () => {
    expect(
      checkRegistry({
        manifests: [
          area(
            'a',
            { ids: index() },
            {
              seeds: [step('a.ids', { writes: ['ids'] })],
              rebuilders: [step('a.ids', { writes: ['ids'] })]
            }
          )
        ],
        codeTables: code('ids')
      }).problems.map((p) => p.detail)
    ).toEqual(['id a.ids names both a seed and a rebuilder']);
  });

  it('refuses a module path that leaves the repo or names its extension', () => {
    const at = (module: string) =>
      step('a.rows', { run: { module, exportName: 'run' }, writes: ['ids'] });
    expect(
      checkRegistry({
        manifests: [
          area(
            'a',
            { ids: index() },
            {
              seeds: [at('../outside/seed')],
              rebuilders: [
                at('src/ids/ids-rebuild.ts'),
                at('/abs/ids'),
                at('src/ids/ids-rebuild.seed')
              ].map((s, i) => ({ ...s, id: `a.rows${i}`, writes: [] }))
            }
          )
        ],
        codeTables: code('ids')
      }).problems.map((p) => p.detail)
    ).toEqual([
      "seed a.rows's module ../outside/seed leaves the repo or has an empty part: name a path in the repo without an extension",
      "rebuilder a.rows0's module src/ids/ids-rebuild.ts carries an extension: name a path in the repo without an extension",
      "rebuilder a.rows1's module /abs/ids is absolute: name a path in the repo without an extension"
    ]);
  });

  describe('a planned rebuilder whose module is not here yet', () => {
    // The mirror's module lands with a later change; the reader of its
    // table and the owner of a column of it don't wait on it yet.
    const mirror = step('a.mirror', {
      run: { module: 'src/later/mirror', exportName: 'run' },
      origin: 'planned',
      writes: ['mirrored', 'drops']
    });
    const rebuilders = (planned: RebuildStep) => [
      step('a.reader', { writes: ['derived'], reads: ['mirrored'] }),
      step('a.owner', {
        writes: [{ table: 'drops', columns: ['rank'], reason: 'ranks' }]
      }),
      planned
    ];
    const check = (codeHere: boolean, planned: RebuildStep = mirror) =>
      checkRegistry({
        manifests: [
          area(
            'a',
            { mirrored: index(), drops: index(), derived: index() },
            { rebuilders: rebuilders(planned) }
          )
        ],
        codeTables: code('mirrored', 'drops', 'derived'),
        stepCodeHere: (s) => s.origin !== 'planned' || codeHere
      });

    it('leaves its writes out of the order checks, and names them', () => {
      const result = check(false);
      expect(result.problems).toEqual([]);
      expect(result.orderLeftOut).toEqual([
        { step: 'a.mirror', tables: ['mirrored', 'drops'] }
      ]);
    });

    it('checks them once the module is here', () => {
      const result = check(true);
      expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
        [
          'BAD_ORDER',
          "rebuilder a.reader reads mirrored, which a.mirror rebuilds; add after: ['a.mirror']"
        ],
        [
          'BAD_ORDER',
          "column owner a.owner of drops must run after its row writer; add after: ['a.mirror']"
        ]
      ]);
      expect(result.orderLeftOut).toEqual([]);
      // As without a check of the code: every write is checked.
      expect(
        checkRegistry({
          manifests: [
            area(
              'a',
              { mirrored: index(), drops: index(), derived: index() },
              { rebuilders: rebuilders(mirror) }
            )
          ],
          codeTables: code('mirrored', 'drops', 'derived')
        }).problems.map((p) => p.kind)
      ).toEqual(['BAD_ORDER', 'BAD_ORDER']);
    });

    it('still fails an unknown id in its after or before', () => {
      const result = check(false, {
        ...mirror,
        after: ['a.nowhere'],
        before: ['b.nowhere']
      });
      expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
        ['BAD_ORDER', 'a rebuilder waits on unknown step a.nowhere'],
        ['BAD_ORDER', 'a rebuilder waits on unknown step b.nowhere']
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

  it('keeps exempt columns to INDEX tables, with a reason, and no owner', () => {
    const result = checkRegistry({
      manifests: [
        area(
          'a',
          {
            ids: {
              class: 'INDEX',
              exemptColumns: [
                {
                  column: 'xtdh',
                  reason: 'the retired feature, kept by backups'
                },
                { column: 'tdh', reason: 'no step rebuilds it' },
                { column: 'level', reason: ' ' }
              ]
            },
            kept: {
              class: 'EPHEMERAL',
              why: 'a cache',
              exemptColumns: [{ column: 'x', reason: 'y' }]
            }
          },
          {
            rebuilders: [
              step('a.rows', { writes: ['ids'] }),
              step('a.tdh', {
                writes: [{ table: 'ids', columns: ['tdh'], reason: 'x' }],
                after: ['a.rows']
              })
            ]
          }
        )
      ],
      codeTables: code('ids', 'kept')
    });
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
      ['BAD_EXEMPT', 'ids.level is exempt without a reason'],
      [
        'BAD_EXEMPT',
        'kept is EPHEMERAL; only an INDEX table has exempt columns'
      ],
      [
        'BAD_EXEMPT',
        'ids.tdh is exempt and owned by a.tdh; an exempt column has no owner'
      ]
    ]);
  });

  it('takes an until only on an EXEMPT table, and only as a real day', () => {
    const result = checkRegistry({
      manifests: [
        area('a', {
          held: { class: 'EXEMPT', why: 'held entries', until: '2026-12-04' },
          bad_day: { class: 'EXEMPT', why: 'x', until: '2026-02-30' },
          bad_form: { class: 'EXEMPT', why: 'x', until: '4 Dec 2026' },
          kept: { class: 'EPHEMERAL', why: 'a cache', until: '2026-12-04' }
        })
      ],
      codeTables: code('held', 'bad_day', 'bad_form', 'kept')
    });
    expect(result.problems.map((p) => [p.kind, p.detail])).toEqual([
      [
        'BAD_EXEMPT',
        "bad_day's until '2026-02-30' is not a day written YYYY-MM-DD"
      ],
      [
        'BAD_EXEMPT',
        "bad_form's until '4 Dec 2026' is not a day written YYYY-MM-DD"
      ],
      ['BAD_EXEMPT', 'kept is EPHEMERAL; only an EXEMPT table has an until']
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
