import * as fc from 'fast-check';
import {
  columnPlanDecision,
  columnPlanProblem,
  rowAndColumnPlanOverlap
} from '@/rebuild/run/column-plans';
import { differingColumns } from '@/rebuild/snapshot/table-snapshot';
import { Row, scopeFlag } from '@/rebuild/stack/mysql-admin';

const row = (id: number, name: string, at: string, rank = 0): Row => ({
  id,
  name,
  at,
  rank
});
const byKey = (...rows: Row[]) =>
  new Map(rows.map((r) => [JSON.stringify([r.id]), r]));
const key = (id: number) => JSON.stringify([id]);

describe('column plans', () => {
  const seeded = byKey(row(1, 'a', 't1'), row(2, 'b', 't1'), row(3, 'c', 't1'));
  const decide = (
    plans: { columns: string[]; ids: number[] }[],
    rebuilt: Map<string, Row>,
    volatile: string[] = []
  ) =>
    columnPlanDecision({
      plans: plans.map((p) => ({
        columns: p.columns,
        rows: new Map(p.ids.map((id) => [key(id), seeded.get(key(id))!]))
      })),
      changed: Array.from(seeded.keys()).filter(
        (k) =>
          rebuilt.has(k) &&
          JSON.stringify(rebuilt.get(k)) !== JSON.stringify(seeded.get(k))
      ),
      rebuilt,
      volatile: new Set(volatile)
    });

  it('excuses a matched row changed only in a planned column, and counts it', () => {
    const result = decide(
      [{ columns: ['name'], ids: [1] }],
      byKey(row(1, 'A', 't1'), row(2, 'b', 't1'), row(3, 'c', 't1'))
    );
    expect(Array.from(result.excused)).toEqual([key(1)]);
    expect(result.counts).toEqual([
      { differing: 1, excused: 1, byColumn: { name: 1 } }
    ]);
  });

  it('leaves a scoped volatile column out of a row only where both sides matched its condition', () => {
    const flagged = (r: Row, on: boolean): Row => ({
      ...r,
      [scopeFlag(0)]: on ? '1' : '0'
    });
    const plans = [
      {
        columns: ['name'],
        rows: new Map([
          [key(1), flagged(row(1, 'a', 't1'), true)],
          [key(2), flagged(row(2, 'b', 't1'), true)]
        ])
      }
    ];
    const result = columnPlanDecision({
      plans,
      changed: [key(1), key(2)],
      rebuilt: new Map([
        // Renamed and renumbered: at is left out, both sides matched.
        [key(1), flagged(row(1, 'A', 't9'), true)],
        // Matched before only: at is compared there, so it still differs.
        [key(2), flagged(row(2, 'B', 't9'), false)]
      ]),
      volatile: new Set(),
      scoped: [{ column: 'at', where: "name <> ''" }]
    });
    expect(Array.from(result.excused)).toEqual([key(1)]);
    expect(result.counts).toEqual([
      { differing: 2, excused: 1, byColumn: { name: 2 } }
    ]);
  });

  it('still differs on a matched row changed in a planned and an unplanned column', () => {
    const result = decide(
      [{ columns: ['name'], ids: [1] }],
      byKey(row(1, 'A', 't2'), row(2, 'b', 't1'), row(3, 'c', 't1'))
    );
    expect(result.excused.size).toBe(0);
    // Counted as differing in its planned column, but not left out.
    expect(result.counts).toEqual([
      { differing: 1, excused: 0, byColumn: { name: 1 } }
    ]);
  });

  it('never excuses a matched row that is missing, or a row no plan matched', () => {
    const missing = decide(
      [{ columns: ['name'], ids: [1, 2] }],
      byKey(row(2, 'B', 't1'), row(3, 'C', 't1'))
    );
    expect(Array.from(missing.excused)).toEqual([key(2)]);
    expect(missing.counts[0].differing).toBe(1);
  });

  it('takes the union of the column plans that match a row', () => {
    const result = decide(
      [
        { columns: ['name'], ids: [1] },
        { columns: ['at'], ids: [1] }
      ],
      byKey(row(1, 'A', 't2'), row(2, 'b', 't1'), row(3, 'c', 't1'))
    );
    expect(Array.from(result.excused)).toEqual([key(1)]);
    expect(result.counts).toEqual([
      { differing: 1, excused: 1, byColumn: { name: 1 } },
      { differing: 1, excused: 1, byColumn: { at: 1 } }
    ]);
  });

  it('leaves volatile columns out, and counts each column', () => {
    const result = decide(
      [{ columns: ['name', 'rank'], ids: [1, 2, 3] }],
      byKey(row(1, 'A', 't9', 0), row(2, 'B', 't1', 5), row(3, 'c', 't9', 5)),
      ['at']
    );
    expect(Array.from(result.excused).sort()).toEqual(
      [key(1), key(2), key(3)].sort()
    );
    expect(result.counts).toEqual([
      { differing: 3, excused: 3, byColumn: { name: 2, rank: 2 } }
    ]);
  });

  it('excuses only matched changed rows, and only within their plans', () => {
    const names = ['a', 'b', 'c'] as const;
    const value = fc.integer({ min: 0, max: 2 });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(value, value, value), { minLength: 1, maxLength: 6 }),
        fc.array(fc.tuple(value, value, value), { minLength: 1, maxLength: 6 }),
        fc.array(
          fc.record({
            columns: fc.subarray([...names], { minLength: 1 }),
            ids: fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 6 })
          }),
          { maxLength: 3 }
        ),
        (before, after, plans) => {
          const asRow = (id: number, [a, b, c]: number[]): Row => ({
            id,
            a,
            b,
            c
          });
          const seededRows = new Map(
            before.map((v, id) => [key(id), asRow(id, v)])
          );
          const rebuilt = new Map(
            after.map((v, id) => [key(id), asRow(id, v)])
          );
          const changed = Array.from(seededRows.keys()).filter(
            (k) =>
              rebuilt.has(k) &&
              JSON.stringify(rebuilt.get(k)) !==
                JSON.stringify(seededRows.get(k))
          );
          const columnPlans = plans.map((p) => ({
            columns: p.columns,
            rows: new Map(
              p.ids
                .filter((id) => seededRows.has(key(id)))
                .map((id) => [key(id), seededRows.get(key(id))!])
            )
          }));
          const { excused } = columnPlanDecision({
            plans: columnPlans,
            changed,
            rebuilt,
            volatile: new Set()
          });
          for (const k of Array.from(excused)) {
            expect(changed).toContain(k);
            const covering = columnPlans.filter((p) => p.rows.has(k));
            expect(covering.length).toBeGreaterThan(0);
            const allowed = covering.flatMap((p) => p.columns);
            for (const column of differingColumns(
              seededRows.get(k)!,
              rebuilt.get(k)!
            )) {
              expect(allowed).toContain(column);
            }
          }
        }
      )
    );
  });

  it('refuses an unknown column, a key column, and a table without a usable key', () => {
    const base = {
      step: 'waves.mirror',
      table: 'waves',
      columns: ['updated_at'],
      names: ['id', 'name', 'updated_at'],
      key: ['id'],
      volatile: new Set<string>()
    };
    expect(columnPlanProblem(base)).toBeNull();
    expect(columnPlanProblem({ ...base, columns: ['nope'] })).toBe(
      "waves.mirror plans columns nope of waves, which the schema doesn't have"
    );
    expect(columnPlanProblem({ ...base, columns: ['id', 'name'] })).toBe(
      'waves.mirror plans id of waves, in its primary key; a column plan finds its rows by key'
    );
    const noKey =
      'waves.mirror plans columns of waves, which has no primary key without a volatile column to find its rows by after the rebuild; a declared rowKey can name a unique key without one';
    expect(columnPlanProblem({ ...base, key: [] })).toBe(noKey);
    expect(columnPlanProblem({ ...base, volatile: new Set(['id']) })).toBe(
      noKey
    );
  });

  it('finds rows by a declared row key, whatever the primary key holds', () => {
    // waves: serial_no, the primary key, is volatile; id is its rowKey.
    const declared = {
      step: 'waves.mirror',
      table: 'waves',
      columns: ['updated_at', 'serial_no'],
      names: ['serial_no', 'id', 'updated_at'],
      key: ['id'],
      declared: true,
      volatile: new Set(['serial_no'])
    };
    expect(columnPlanProblem(declared)).toBeNull();
    expect(columnPlanProblem({ ...declared, columns: ['id'] })).toBe(
      'waves.mirror plans id of waves, in its declared row key; a column plan finds its rows by key'
    );
    expect(columnPlanProblem({ ...declared, volatile: new Set(['id']) })).toBe(
      'waves.mirror plans columns of waves, which has no declared row key without a volatile column to find its rows by after the rebuild'
    );
  });

  it('refuses a row that a plan of whole rows and a column plan both match', () => {
    expect(
      rowAndColumnPlanOverlap('waves', [
        { step: 'waves.a', keys: ['[1]', '[2]'] },
        { step: 'waves.b', columns: ['name'], keys: ['[3]', '[2]'] }
      ])
    ).toBe(
      "planned rows of waves: waves.a's plan of whole rows and waves.b's column plan both match the row [2]; a row is either missing or back with planned columns, not both"
    );
    // Large plans, as on an audit table: found at once, without comparing
    // every key with every other.
    const many = (from: number) =>
      Array.from({ length: 50_000 }, (_, i) => `[${from + i}]`);
    expect(
      rowAndColumnPlanOverlap('audit', [
        { step: 'audit.rows', keys: many(0) },
        { step: 'audit.columns', columns: ['action'], keys: many(50_000) }
      ])
    ).toBeNull();
    expect(
      rowAndColumnPlanOverlap('audit', [
        { step: 'audit.rows', keys: many(0) },
        { step: 'audit.columns', columns: ['action'], keys: many(49_999) }
      ])
    ).toMatch(/both match the row \[49999\]/);
    expect(
      rowAndColumnPlanOverlap('waves', [
        { step: 'waves.a', keys: ['[1]'] },
        { step: 'waves.b', columns: ['name'], keys: ['[3]'] },
        { step: 'waves.c', columns: ['at'], keys: ['[3]'] }
      ])
    ).toBeNull();
  });
});
