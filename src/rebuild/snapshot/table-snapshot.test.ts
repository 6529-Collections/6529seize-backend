import * as fc from 'fast-check';
import {
  canonicalRow,
  changedKeys,
  diffSnapshots,
  differingColumns,
  goneRows,
  scopeCounts,
  snapshotRows
} from '@/rebuild/snapshot/table-snapshot';
import { Row, scopeFlag } from '@/rebuild/stack/mysql-admin';

describe('table snapshots', () => {
  it('canonicalizes column order, buffers and volatile columns', () => {
    expect(
      canonicalRow(
        { b: Buffer.from([1, 2]), a: 1, updated_at: '2026-01-01' },
        new Set(['updated_at'])
      )
    ).toBe('{"a":1,"b":"0x0102"}');
  });

  it('gives the same digest whatever the column order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,5}$/),
          fc.oneof(fc.integer(), fc.string(), fc.constant(null))
        ),
        (row) => {
          const reversed = Object.fromEntries(Object.entries(row).reverse());
          expect(snapshotRows('t', [row], []).digest).toBe(
            snapshotRows('t', [reversed], []).digest
          );
        }
      )
    );
  });

  it('orders rows without a primary key by content', () => {
    const one = { v: 1 };
    const two = { v: 2 };
    expect(snapshotRows('t', [one, two], []).digest).toBe(
      snapshotRows('t', [two, one], []).digest
    );
  });

  it('matches rows by content when the primary key is volatile', () => {
    const volatile = new Set(['id']);
    const before = snapshotRows(
      't',
      [
        { id: 1, v: 'a' },
        { id: 2, v: 'b' }
      ],
      ['id'],
      volatile
    );
    // A rebuild that numbers the same rows anew, in another order.
    const renumbered = snapshotRows(
      't',
      [
        { id: 7, v: 'b' },
        { id: 8, v: 'a' }
      ],
      ['id'],
      volatile
    );
    expect(diffSnapshots(before, renumbered).same).toBe(true);
    const changed = snapshotRows(
      't',
      [
        { id: 7, v: 'b' },
        { id: 8, v: 'c' }
      ],
      ['id'],
      volatile
    );
    const diff = diffSnapshots(before, changed);
    expect(diff.same).toBe(false);
    expect(diff.missing).toHaveLength(1);
    expect(diff.extra).toHaveLength(1);
  });

  describe('a declared row key and scoped volatile columns', () => {
    // waves: serial_no, the primary key, is numbered anew by a rebuild;
    // id is unique and keys the rows (its rowKey).
    const wave = (serial: number, id: string, name: string, at = 't1') => ({
      serial_no: serial,
      id,
      name,
      at
    });

    it('keys rows by the declared key, so a renumbered serial is the same row changed', () => {
      const before = snapshotRows(
        'waves',
        [wave(161, 'w-161', 'a'), wave(5000, '0xabc', 'b')],
        ['id']
      );
      const after = snapshotRows(
        'waves',
        [wave(161, 'w-161', 'a'), wave(162, '0xabc', 'b')],
        ['id']
      );
      expect(before.keys).toEqual(['["w-161"]', '["0xabc"]']);
      const diff = diffSnapshots(before, after);
      expect([diff.same, diff.missing, diff.extra, diff.changed]).toEqual([
        false,
        [],
        [],
        ['["0xabc"]']
      ]);
    });

    it('leaves a scoped column out only of the rows its flag marks', () => {
      const scoped = [{ column: 'serial_no', where: "id LIKE '0x%'" }];
      const read = (row: Row, on: boolean): Row => ({
        ...row,
        [scopeFlag(0)]: on ? '1' : '0'
      });
      const snap = (...rows: Row[]) =>
        snapshotRows('waves', rows, ['id'], new Set(), scoped);
      const before = snap(
        read(wave(161, 'w-161', 'a'), false),
        read(wave(5000, '0xabc', 'b'), true),
        read(wave(5001, '0xdef', 'c'), true)
      );
      // The chain-made waves come back renumbered: the same.
      const renumbered = snap(
        read(wave(161, 'w-161', 'a'), false),
        read(wave(162, '0xabc', 'b'), true),
        read(wave(163, '0xdef', 'c'), true)
      );
      expect(diffSnapshots(before, renumbered).same).toBe(true);
      expect(before.scoped).toEqual([
        { column: 'serial_no', keys: ['["0xabc"]', '["0xdef"]'] }
      ]);
      // The imported wave's serial is still compared.
      const imported = snap(
        read(wave(7, 'w-161', 'a'), false),
        read(wave(162, '0xabc', 'b'), true),
        read(wave(163, '0xdef', 'c'), true)
      );
      expect(diffSnapshots(before, imported).changed).toEqual(['["w-161"]']);
      // A row the condition matches on one side only is compared there.
      const oneSide = snap(
        read(wave(161, 'w-161', 'a'), false),
        read(wave(162, '0xabc', 'b'), false),
        read(wave(5001, '0xdef', 'c'), true)
      );
      expect(diffSnapshots(before, oneSide).changed).toEqual(['["0xabc"]']);
      expect(scopeCounts(before, oneSide)).toEqual([
        { column: 'serial_no', before: 2, after: 1, oneSide: 1 }
      ]);
      expect(scopeCounts(before, renumbered)).toEqual([
        { column: 'serial_no', before: 2, after: 2, oneSide: 0 }
      ]);
      // The flag columns never reach the hash: a row read without scoping
      // hashes as the scoped read of a row its condition didn't match.
      expect(
        snapshotRows('waves', [wave(161, 'w-161', 'a')], ['id']).hashes
      ).toEqual(snap(read(wave(161, 'w-161', 'a'), false)).hashes);
    });

    it('takes a key holding a scoped column as no key', () => {
      const scoped = [{ column: 'serial_no', where: '1 = 1' }];
      const snap = snapshotRows(
        'waves',
        [{ ...wave(1, '0xabc', 'b'), [scopeFlag(0)]: '1' }],
        ['serial_no'],
        new Set(),
        scoped
      );
      expect(snap.keys).toEqual(snap.hashes);
    });
  });

  it('reports rows only before, only after and changed, by primary key', () => {
    const before = snapshotRows(
      't',
      [
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
        { id: 3, v: 'c' }
      ],
      ['id']
    );
    const after = snapshotRows(
      't',
      [
        { id: 2, v: 'b' },
        { id: 3, v: 'changed' },
        { id: 4, v: 'd' }
      ],
      ['id']
    );
    expect(diffSnapshots(before, after)).toEqual({
      table: 't',
      rowsBefore: 3,
      rowsAfter: 3,
      same: false,
      missing: ['[1]'],
      planned: [],
      plannedRows: 0,
      plannedColumns: [],
      plannedColumnRows: 0,
      extra: ['[4]'],
      changed: ['[3]']
    });
    expect(diffSnapshots(before, before).same).toBe(true);
  });

  describe('planned rows', () => {
    const rows = (...list: [number, string][]) =>
      snapshotRows(
        't',
        list.map(([id, v]) => ({ id, v })),
        ['id']
      );
    const seeded = rows([1, 'a'], [2, 'b'], [3, 'c']);
    const planned = ['[3]'];

    it('lists a planned row missing apart, and the table is the same', () => {
      expect(
        diffSnapshots(seeded, rows([1, 'a'], [2, 'b']), 20, planned)
      ).toEqual({
        table: 't',
        rowsBefore: 3,
        rowsAfter: 2,
        same: true,
        missing: [],
        planned: ['[3]'],
        plannedRows: 1,
        plannedColumns: [],
        plannedColumnRows: 0,
        extra: [],
        changed: []
      });
    });

    it('still differs on an extra row, a changed planned row, or a missing row not planned', () => {
      const diff = (after: ReturnType<typeof rows>) =>
        diffSnapshots(seeded, after, 20, planned);
      // The rebuild has a row matching the plan that the seed doesn't.
      expect(diff(rows([1, 'a'], [2, 'b'], [4, 'c']))).toMatchObject({
        same: false,
        planned: ['[3]'],
        extra: ['[4]']
      });
      // A planned row on both sides that changed.
      expect(diff(rows([1, 'a'], [2, 'b'], [3, 'changed']))).toMatchObject({
        same: false,
        planned: [],
        changed: ['[3]']
      });
      // A row the plan doesn't cover.
      expect(diff(rows([2, 'b']))).toMatchObject({
        same: false,
        missing: ['[1]'],
        planned: ['[3]']
      });
    });

    it("leaves out rows that changed only in a plan's columns, and nothing else", () => {
      const after = rows([1, 'a'], [2, 'B'], [3, 'C']);
      expect(changedKeys(seeded, after)).toEqual(['[2]', '[3]']);
      // The runner decides which changed rows a column plan covers.
      expect(
        diffSnapshots(seeded, after, 20, [], new Set(['[3]']))
      ).toMatchObject({
        same: false,
        changed: ['[2]'],
        plannedColumns: ['[3]'],
        plannedColumnRows: 1
      });
      expect(
        diffSnapshots(seeded, after, 20, [], new Set(['[2]', '[3]']))
      ).toMatchObject({ same: true, changed: [], plannedColumnRows: 2 });
      // A row a column plan covers must still come back.
      expect(
        diffSnapshots(
          seeded,
          rows([1, 'a'], [2, 'b']),
          20,
          [],
          new Set(['[3]'])
        )
      ).toMatchObject({ same: false, missing: ['[3]'], plannedColumnRows: 0 });
    });

    it('names the columns two versions of a row differ in, leaving out volatile ones', () => {
      const at = new Date('2026-11-24T00:00:00Z');
      expect(
        differingColumns(
          { id: 1, name: 'a', at, blob: Buffer.from('x'), gone: 1 },
          {
            id: 1,
            name: 'b',
            at: new Date(at.getTime()),
            blob: Buffer.from('y'),
            added: 2
          },
          new Set(['added'])
        )
      ).toEqual(['blob', 'gone', 'name']);
      expect(differingColumns({ id: 1, v: null }, { id: 1, v: null })).toEqual(
        []
      );
    });

    describe('rows without a key, which match by hash', () => {
      const keyless = (...values: string[]) =>
        snapshotRows(
          't',
          values.map((v) => ({ v })),
          []
        );
      // One key per planned row, as the run takes a plan's rows.
      const plannedOf = (...values: string[]) => keyless(...values).keys;
      const [hashA] = plannedOf('a');
      const [hashB] = plannedOf('b');

      it('keeps them apart by count, not only by hash', () => {
        const before = keyless('a', 'a', 'b');
        // One of the two equal rows is gone and isn't planned: it differs.
        expect(
          diffSnapshots(before, keyless('a'), 20, plannedOf('b'))
        ).toMatchObject({
          same: false,
          missing: [hashA],
          planned: [hashB],
          plannedRows: 1
        });
        expect(
          diffSnapshots(before, keyless('a', 'a'), 20, plannedOf('b'))
        ).toMatchObject({ same: true, missing: [], plannedRows: 1 });
      });

      it('compares the count of every hash, not the set of hashes', () => {
        // P,A,A,B to A,B,B with P planned: one A gone, one B more.
        const moved = diffSnapshots(
          keyless('p', 'a', 'a', 'b'),
          keyless('a', 'b', 'b'),
          20,
          plannedOf('p')
        );
        expect(moved).toMatchObject({
          same: false,
          missing: [hashA],
          extra: [hashB],
          plannedRows: 1
        });
        // X,X,Y to Y with one X planned: the other X is missing.
        const [hashX] = plannedOf('x');
        expect(
          diffSnapshots(
            keyless('x', 'x', 'y'),
            keyless('y'),
            20,
            plannedOf('x')
          )
        ).toMatchObject({
          same: false,
          missing: [hashX],
          planned: [hashX],
          plannedRows: 1
        });
        // With both X planned, the rebuild lacks only planned rows.
        expect(
          diffSnapshots(
            keyless('x', 'x', 'y'),
            keyless('y'),
            20,
            plannedOf('x', 'x')
          )
        ).toMatchObject({ same: true, missing: [], plannedRows: 2 });
      });

      it('counts like a multiset: only rows no plan covers differ', () => {
        const value = fc.constantFrom('a', 'b', 'c');
        const flags = fc.array(fc.boolean(), { minLength: 8, maxLength: 8 });
        fc.assert(
          fc.property(
            fc.array(value, { maxLength: 8 }),
            flags,
            flags,
            value,
            (seeded, isPlanned, isGone, one) => {
              const planned = seeded.filter((_, i) => isPlanned[i]);
              // The rebuild lacks some of the planned rows.
              const gone = seeded.filter((_, i) => isPlanned[i] && isGone[i]);
              const kept = seeded.filter(
                (_, i) => !(isPlanned[i] && isGone[i])
              );
              const before = keyless(...seeded);
              const keys = plannedOf(...planned);
              const count = (list: string[], v: string) =>
                list.filter((x) => x === v).length;
              const diff = diffSnapshots(before, keyless(...kept), 20, keys);
              expect(diff).toMatchObject({
                same: true,
                missing: [],
                extra: [],
                plannedRows: gone.length
              });
              expect(goneRows(before, keyless(...kept), keys)).toBe(
                gone.length
              );
              // One more row of a value lacking: equal rows can't be told
              // apart, so it differs only once that value's planned rows
              // are all gone.
              const at = kept.indexOf(one);
              if (at >= 0) {
                const fewer = kept.filter((_, i) => i !== at);
                expect(
                  diffSnapshots(before, keyless(...fewer), 20, keys).same
                ).toBe(count(planned, one) > count(gone, one));
              }
              // One more row of a value: the same only while it stands for
              // a planned row the rebuild lacked.
              expect(
                diffSnapshots(before, keyless(...kept, one), 20, keys).same
              ).toBe(count(gone, one) > 0);
            }
          )
        );
      });
    });
  });
});
