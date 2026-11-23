import * as fc from 'fast-check';
import {
  canonicalRow,
  diffSnapshots,
  snapshotRows
} from '@/rebuild/snapshot/table-snapshot';

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
    const planned = new Set(['[3]']);

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

    it('keeps rows without a key apart by count, not only by hash', () => {
      const keyless = (...values: string[]) =>
        snapshotRows(
          't',
          values.map((v) => ({ v })),
          []
        );
      const before = keyless('a', 'a', 'b');
      const [hashB] = keyless('b').keys;
      // One of the two equal rows is gone and isn't planned: it differs.
      expect(
        diffSnapshots(before, keyless('a'), 20, new Set([hashB])).same
      ).toBe(false);
      expect(
        diffSnapshots(before, keyless('a', 'a'), 20, new Set([hashB])).same
      ).toBe(true);
    });
  });
});
