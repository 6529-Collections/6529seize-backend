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
    expect(result.problems.map((p) => p.kind).sort()).toEqual([
      'BAD_ORDER',
      'BAD_ORDER',
      'BAD_STEP',
      'BAD_STEP',
      'BAD_STEP',
      'DOUBLE_WRITER'
    ]);
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
